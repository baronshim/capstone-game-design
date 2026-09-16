import type { RoomObject } from './room';

export interface Env {
  ROOMS: DurableObjectNamespace<RoomObject>;
  ASSETS: Fetcher;
  /** fake | scripted | live */
  BOT_MODE: string;
  /** Workers AI model id for live bots; defaults to Gemma 4 26B. */
  BOT_MODEL?: string;
  /** Rooms per minute per client IP; "0" disables the limit. */
  ROOM_RATE_LIMIT?: string;
  /** Workers AI binding; absent in the test environment. */
  AI?: unknown;
}
