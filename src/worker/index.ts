import { DurableObject } from 'cloudflare:workers';

export class RoomObject extends DurableObject {}

export default {
  async fetch(): Promise<Response> {
    return new Response('ok');
  },
};
