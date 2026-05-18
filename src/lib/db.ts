import Dexie, { type Table } from "dexie";

export interface CachedMessage {
  id: string;           // event ID
  pubkey: string;
  content: string;
  created_at: number;
  sender?: string;      // NEAR account name
  channelId: string;
}

const MAX_PER_CHANNEL = 500;
const MAX_TOTAL = 5000;

class LegionDB extends Dexie {
  messages!: Table<CachedMessage, string>;

  constructor() {
    super("legion-chat");
    this.version(1).stores({
      messages: "id, channelId, pubkey, created_at",
    });
  }
}

const db = new LegionDB();

/** Save a message to cache, enforce limits */
export async function cacheMessage(msg: CachedMessage): Promise<void> {
  try {
    await db.messages.put(msg);
    // Per-channel cleanup
    const count = await db.messages.where("channelId").equals(msg.channelId).count();
    if (count > MAX_PER_CHANNEL) {
      const oldest = await db.messages
        .where("channelId").equals(msg.channelId)
        .sortBy("created_at");
      const toRemove = oldest.slice(0, count - MAX_PER_CHANNEL);
      await db.transaction("rw", db.messages, async () => {
        for (const m of toRemove) await db.messages.delete(m.id);
      });
    }
    // Global cleanup
    const total = await db.messages.count();
    if (total > MAX_TOTAL) {
      const oldest = await db.messages.orderBy("created_at").limit(total - MAX_TOTAL).toArray();
      await db.transaction("rw", db.messages, async () => {
        for (const m of oldest) await db.messages.delete(m.id);
      });
    }
  } catch (e) {
    console.error("cacheMessage error:", e);
  }
}

/** Get cached messages for a channel, most recent first, limited */
export async function getCachedMessages(channelId: string, limit = 100): Promise<CachedMessage[]> {
  try {
    const all = await db.messages.where("channelId").equals(channelId).sortBy("created_at");
    return all.reverse().slice(0, limit);
  } catch (e) {
    console.error("getCachedMessages error:", e);
    return [];
  }
}

/** Get oldest cached message timestamp for pagination */
export async function getOldestCachedTimestamp(channelId: string): Promise<number | null> {
  try {
    const oldest = await db.messages
      .where("channelId").equals(channelId)
      .sortBy("created_at");
    return oldest.length > 0 ? oldest[0].created_at : null;
  } catch {
    return null;
  }
}
