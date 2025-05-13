import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from './config/configuration';
import { validationSchema } from './config/validation';

import { DatabaseModule } from './database/database.module';
import { MqttModule } from './mqtt/mqtt.module';
import { TcpModule } from './tcp/tcp.module';
import { StockModule } from './stock/stock.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validationSchema,
    }),
    DatabaseModule,
    MqttModule,
    TcpModule,
    StockModule,
  ],
})
export class AppModule {}