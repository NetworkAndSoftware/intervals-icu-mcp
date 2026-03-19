export interface ActivitySummary {
  id: string;
  start_date_local: string;
  name: string;
  type: string;
  moving_time: number;
  elapsed_time: number;
  distance: number;
  icu_training_load: number | null;
  icu_intensity: number | null;
  icu_weighted_avg_watts: number | null;
  average_watts: number | null;
  average_heartrate: number | null;
  max_heartrate: number | null;
  total_elevation_gain: number | null;
  calories: number | null;
  icu_ftp: number | null;
  [key: string]: unknown;
}

export interface Activity extends ActivitySummary {
  description: string | null;
  icu_intervals: Interval[] | null;
  laps: Lap[] | null;
  [key: string]: unknown;
}

export interface Interval {
  start_index: number;
  end_index: number;
  duration: number;
  distance: number;
  average_watts: number | null;
  average_heartrate: number | null;
  label: string | null;
  type: string;
  [key: string]: unknown;
}

export interface Lap {
  start_index: number;
  end_index: number;
  elapsed_time: number;
  moving_time: number;
  distance: number;
  average_watts: number | null;
  average_heartrate: number | null;
  [key: string]: unknown;
}

export type StreamType =
  | "watts"
  | "heartrate"
  | "cadence"
  | "latlng"
  | "altitude"
  | "distance"
  | "time"
  | "velocity_smooth"
  | "temp"
  | "torque";

export interface FitnessData {
  date: string;
  ctl: number;
  atl: number;
  tsb: number;
  training_load: number | null;
  [key: string]: unknown;
}

export interface WellnessData {
  id: string;
  date: string;
  weight: number | null;
  restingHR: number | null;
  hrv: number | null;
  sleepTime: number | null;
  sleepScore: number | null;
  sleepQuality: number | null;
  fatigue: number | null;
  mood: number | null;
  readiness: number | null;
  [key: string]: unknown;
}

export interface PowerCurveData {
  durations: number[];
  watts: number[];
  [key: string]: unknown;
}

export interface ZoneConfig {
  id: number;
  name: string;
  zones: Zone[];
  [key: string]: unknown;
}

export interface Zone {
  name: string;
  min: number;
  max: number;
  [key: string]: unknown;
}

export interface CacheEntry {
  key: string;
  value: string;
  fetched_at: number;
  ttl: number;
}
