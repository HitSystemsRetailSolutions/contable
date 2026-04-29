import { Module } from '@nestjs/common';
import { StockController } from './stock.controller';
import { StockService } from './stock.service';
import { IndicadorsService } from './indicadors.service';

@Module({
  controllers: [StockController],
  providers: [StockService, IndicadorsService],
  exports: [StockService, IndicadorsService],
})
export class StockModule {}