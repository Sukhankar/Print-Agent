export type PrinterFormat = 'tspl' | 'escpos' | 'raw';
export type PrinterState = 'online' | 'offline' | 'busy' | 'error';
export type JobStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled' | 'retrying';

export interface PrinterInfo {
  id: string;
  name: string;
  type: PrinterFormat;
  status: PrinterState;
  platform: string;
}

export interface PrinterStatus {
  id: string;
  state: PrinterState;
  detail?: string;
}

export interface PrintJob {
  id: string;
  printerId: string;
  format: PrinterFormat;
  payload: string | Buffer;
  idempotencyKey?: string;
  status: JobStatus;
  createdAt: number;
  attempts?: number;
}

export interface PrintResult {
  success: boolean;
  jobId: string;
  byteLength: number;
  durationMs: number;
}

export interface TargetConfig {
  transport: 'win32' | 'linux' | 'network';
  printerName?: string;
  devicePath?: string;
  host?: string;
  port?: number;
}

export interface PrinterDriver {
  id: string;
  type: PrinterFormat;
  discover(): Promise<PrinterInfo[]>;
  validate(payload: string | Buffer): Promise<boolean>;
  print(job: PrintJob, targetConfig: TargetConfig): Promise<PrintResult>;
  getStatus(printerId: string): Promise<PrinterStatus>;
  cancel(jobId: string): Promise<boolean>;
  close(): Promise<void>;
}
