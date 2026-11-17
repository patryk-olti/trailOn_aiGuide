export interface PeakRow {
  peak_id: string;
  name: string;
  elevation_m: number;
  range_name: string;
  lat: number;
  lng: number;
  tags_json: string;
  description: string | null;
  status: string;
  recommended: number;
}