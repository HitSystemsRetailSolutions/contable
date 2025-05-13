import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as sql from 'mssql';

@Injectable()
export class DatabaseService implements OnModuleInit {
  private pool!: sql.ConnectionPool;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    const dbConf = this.config.get('db');
    this.pool = await new sql.ConnectionPool({
      ...dbConf,
      options: { encrypt: false, trustServerCertificate: true },
      pool: { max: 10, idleTimeoutMillis: 15_000 },
      requestTimeout: 10_000,
    }).connect();
    Logger.log('✅ Connexió MSSQL establerta');
  }

  query<T = unknown>(statement: string) {
    return this.pool.request().query<T>(statement);
  }
}