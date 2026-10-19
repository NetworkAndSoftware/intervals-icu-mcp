import type { StreamType } from "./types.js";
import { todayIn } from "./dates.js";

const BASE_URL = "https://intervals.icu/api/v1";

export class IntervalsClient {
  readonly athleteId: string;
  private authHeader: string;
  private timeZone?: Promise<string | undefined>;
  private coached = new Map<string, IntervalsClient>();

  constructor(athleteId: string, apiKey: string) {
    this.athleteId = athleteId;
    this.authHeader =
      "Basic " + Buffer.from(`API_KEY:${apiKey}`).toString("base64");
  }

  // The same API key acting on another athlete's account. intervals.icu lets a coach's key
  // reach the athletes who accepted them as their coach, and refuses any other athlete.
  // Kept per athlete, so their time zone is fetched once.
  forAthlete(athleteId: string): IntervalsClient {
    let client = this.coached.get(athleteId);
    if (!client) {
      client = new IntervalsClient(athleteId, "");
      client.authHeader = this.authHeader;
      this.coached.set(athleteId, client);
    }
    return client;
  }

  private async request<T>(endpoint: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(
      `${BASE_URL}/athlete/${this.athleteId}${endpoint}`
    );
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
    }

    const res = await fetch(url.toString(), {
      headers: {
        Authorization: this.authHeader,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new IntervalsApiError(res.status, res.statusText, body);
    }

    return (await res.json()) as T;
  }

  async getActivities(oldest: string, newest: string, type?: string) {
    const params: Record<string, string> = { oldest, newest };
    if (type) params.type = type;
    return this.request<unknown[]>("/activities", params);
  }

  // Without intervals=true the answer has no icu_intervals or icu_groups
  async getActivity(id: string) {
    return this.request<unknown>(`/activities/${id}`, { intervals: "true" });
  }

  async getActivityStreams(id: string, types: StreamType[]) {
    const url = new URL(`${BASE_URL}/activity/${id}/streams`);
    url.searchParams.set("types", types.join(","));

    const res = await fetch(url.toString(), {
      headers: {
        Authorization: this.authHeader,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new IntervalsApiError(res.status, res.statusText, body);
    }

    return (await res.json()) as unknown;
  }

  // all=true replaces the activity's intervals; otherwise intervals.icu merges these with them.
  // Not under /athlete/{id}, like the streams: activity IDs are global
  async updateIntervals(id: string, intervals: Record<string, unknown>[], replace: boolean) {
    const url = new URL(`${BASE_URL}/activity/${id}/intervals`);
    url.searchParams.set("all", String(replace));
    const res = await fetch(url.toString(), {
      method: "PUT",
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(intervals),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new IntervalsApiError(res.status, res.statusText, text);
    }

    return (await res.json()) as unknown;
  }

  async getFitness(start: string, end: string) {
    return this.request<unknown[]>("/athlete-summary", { start, end });
  }

  async getEvents(oldest: string, newest: string) {
    return this.request<unknown[]>("/events", { oldest, newest });
  }

  async getEvent(id: number) {
    return this.request<unknown>(`/events/${id}`);
  }

  async getPowerCurve(oldest: string, newest: string) {
    return this.request<unknown>("/activity-power-curves", { oldest, newest });
  }

  async getWellness(oldest: string, newest: string) {
    return this.request<unknown[]>("/wellness", { oldest, newest });
  }

  async getAthlete() {
    return this.request<unknown>("");
  }

  // The athlete's local date. Calendar and wellness entries are keyed by it, and the
  // server's clock can be a day ahead: Lambda runs in UTC, and UTC is past midnight
  // from late afternoon in the Americas.
  async today(): Promise<string> {
    this.timeZone ??= this.getAthlete().then(
      a => (a as { timezone?: string }).timezone,
      () => { this.timeZone = undefined; return undefined; }
    );
    return todayIn(await this.timeZone);
  }

  async getSportSettings() {
    return this.request<unknown[]>("/sport-settings");
  }

  async updateAthlete(fields: Record<string, unknown>) {
    const url = new URL(`${BASE_URL}/athlete/${this.athleteId}`);
    const res = await fetch(url.toString(), {
      method: "PUT",
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(fields),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new IntervalsApiError(res.status, res.statusText, text);
    }

    return (await res.json()) as unknown;
  }

  // Takes the numeric entry ID: by type name, intervals.icu silently updates the
  // "Other" entry when no entry lists that type
  async updateSportSettings(id: number, fields: Record<string, unknown>, recalcHrZones: boolean) {
    const url = new URL(`${BASE_URL}/athlete/${this.athleteId}/sport-settings/${id}`);
    url.searchParams.set("recalcHrZones", String(recalcHrZones));
    const res = await fetch(url.toString(), {
      method: "PUT",
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(fields),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new IntervalsApiError(res.status, res.statusText, text);
    }

    return (await res.json()) as unknown;
  }

  async uploadActivity(fileBuffer: Buffer, filename: string, name?: string, description?: string) {
    const url = new URL(`${BASE_URL}/athlete/${this.athleteId}/activities`);
    if (name) url.searchParams.set("name", name);
    if (description) url.searchParams.set("description", description);

    const boundary = "----IntervalsUpload" + Date.now();
    const parts: Buffer[] = [];
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
    parts.push(fileBuffer);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    const body = Buffer.concat(parts);

    const res = await fetch(url.toString(), {
      method: "POST",
      headers: {
        Authorization: this.authHeader,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new IntervalsApiError(res.status, res.statusText, text);
    }

    return (await res.json()) as unknown;
  }

  // Not under /athlete/{id} like the GET (activity IDs are global): there, DELETE gets a 405
  async deleteActivity(id: string) {
    const url = new URL(`${BASE_URL}/activity/${id}`);
    const res = await fetch(url.toString(), {
      method: "DELETE",
      headers: { Authorization: this.authHeader },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new IntervalsApiError(res.status, res.statusText, text);
    }

    return { deleted: true, id };
  }

  async deleteEvent(id: number) {
    const url = new URL(`${BASE_URL}/athlete/${this.athleteId}/events/${id}`);
    const res = await fetch(url.toString(), {
      method: "DELETE",
      headers: { Authorization: this.authHeader },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new IntervalsApiError(res.status, res.statusText, text);
    }

    return { deleted: true, id };
  }

  async updateEvent(id: number, fields: Record<string, unknown>) {
    const url = new URL(`${BASE_URL}/athlete/${this.athleteId}/events/${id}`);
    const res = await fetch(url.toString(), {
      method: "PUT",
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(fields),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new IntervalsApiError(res.status, res.statusText, text);
    }

    return (await res.json()) as unknown;
  }

  async createEvent(event: Record<string, unknown>) {
    const url = new URL(`${BASE_URL}/athlete/${this.athleteId}/events`);
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(event),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new IntervalsApiError(res.status, res.statusText, text);
    }

    return (await res.json()) as unknown;
  }
}

export class IntervalsApiError extends Error {
  constructor(
    public status: number,
    public statusText: string,
    public body: string
  ) {
    let msg = `intervals.icu API error: ${status} ${statusText}`;
    if (status === 401) msg = "Authentication failed — check your INTERVALS_ATHLETE_ID and INTERVALS_API_KEY";
    else if (status === 403) msg = "Access denied — for another athlete's account, check that they've accepted you as their coach";
    else if (status === 404) msg = "Resource not found — check the activity ID or endpoint";
    else if (status === 429) msg = "Rate limited — try again in a moment";
    else if (body) msg += ` — ${body.slice(0, 200)}`;
    super(msg);
    this.name = "IntervalsApiError";
  }
}
