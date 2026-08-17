import { EventEmitter } from 'events';
import { PrinterInfo, PrintJob, PrintResult, PrinterFormat } from '@jp-pos/print-agent-types';

export interface PrintAgentOptions {
  endpoint?: string;
  token: string;
  timeout?: number;
}

export interface PrintOptions {
  printerId: string;
  format?: PrinterFormat;
  data: string | Buffer;
  idempotencyKey?: string;
}

export class PrintAgent extends EventEmitter {
  constructor(options: PrintAgentOptions);
  
  connected: boolean;
  endpoint: string;
  
  connect(): Promise<boolean>;
  disconnect(): Promise<void>;
  health(): Promise<{ status: string; platform: string; uptime: number }>;
  print(options: PrintOptions): Promise<{ success: boolean; job: PrintJob }>;
  
  printers: {
    list(): Promise<{ success: boolean; printers: PrinterInfo[] }>;
    get(id: string): Promise<{ success: boolean; printer: PrinterInfo }>;
  };
  
  jobs: {
    get(id: string): Promise<{ success: boolean; job: PrintJob }>;
    cancel(id: string): Promise<{ success: boolean }>;
    retry(id: string): Promise<{ success: boolean }>;
  };
}
