export interface Message {
  id: string;
  pubkey: string;
  content: string;
  created_at: number;
  sender?: string;
  pending?: boolean;
  failed?: boolean;
  replyToId?: string;
  replyToContent?: string;
  replyToSender?: string;
  quoteId?: string;
  mentions?: string[]; // mentioned pubkeys
  reactions?: Record<string, string[]>; // emoji -> [pubkey, ...]
}

export interface Profile {
  name?: string;
  picture?: string;
  display_name?: string;
  about?: string;
  nip05?: string;
}
