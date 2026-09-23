import { randomUUID } from 'node:crypto';

export class ActivityOutbox {
  id: string = randomUUID();
  payload!: Record<string, any>;
  createdAt: Date = new Date();
  attempts: number = 0;
}
