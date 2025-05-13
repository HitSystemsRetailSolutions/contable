import { Module } from '@nestjs/common';
import { TcpGateway } from './tcp.gateway';
import { StockModule } from '../stock/stock.module';

@Module({
  imports: [StockModule],
  providers: [TcpGateway],
})
export class TcpModule {}
