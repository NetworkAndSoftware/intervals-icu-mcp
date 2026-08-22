import type { StreamType } from "./types.js";

const BASE_URL = "https://intervals.icu/api/v1";

export class IntervalsClient {
  readonly athleteId: string;
  private authHeader: string;

  constructor(athleteId: string, apiKey: string) {
    this.athleteId = athleteId;
    this.authHeader =
      "Basic " + Buffer.from(`API_KEY:${apiKey}`).toString("base64");
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

  async getActivity(id: string) {
    return this.request<unknown>(`/activities/${id}`);
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

  async getFitness(start: string, end: string) {
    return this.request<unknown[]>("/athlete-summary", { start, end });
  }

  async getEvents(oldest: string, newest: string) {
    return this.request<unknown[]>("/events", { oldest, newest });
  }

  async getPowerCurve(oldest: string, newest: string) {
    return this.request<unknown>("/activity-power-curves", { oldest, newest });
  }

  async getWellness(oldest: string, newest: string) {
    return this.request<unknown[]>("/wellness", { oldest, newest });
  }

  async getZones() {
    return this.request<unknown[]>("/sport-settings");
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

  async deleteActivity(id: string) {
    const url = new URL(`${BASE_URL}/athlete/${this.athleteId}/activities/${id}`);
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
    else if (status === 404) msg = "Resource not found — check the activity ID or endpoint";
    else if (status === 429) msg = "Rate limited — try again in a moment";
    else if (body) msg += ` — ${body.slice(0, 200)}`;
    super(msg);
    this.name = "IntervalsApiError";
  }
}
