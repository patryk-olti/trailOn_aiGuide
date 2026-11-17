export interface R2ObjectRef {
  key: string;
  etag?: string;
  size?: number;
}

export interface R2ObjectBody {
  key: string;
  etag?: string;
  text: string;
}