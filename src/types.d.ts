export interface CaptureRecord {
  id: string;
  collectionId?: string;
  collectionName?: string; // 'captures'
  created: string; // ISO
  device_id: 'esp32s3cam-01' | 'esp32s3cam-02' | 'esp32s3cam-03' | 'esp32s3cam-04' | string;
  image: string; // file name
}
