import type { RoomObject } from './room';

export interface Env {
  ROOMS: DurableObjectNamespace<RoomObject>;
  ASSETS: Fetcher;
  BOT_MODE: string;
}
