import { Controller, Post, Body } from '@nestjs/common';
import { StockService } from './stock.service';
import { IndicadorsService } from './indicadors.service';
import { MessageDto } from './dto/message.dto';

@Controller('stock')
export class StockController {
  constructor(
    private readonly stock: StockService,
    private readonly indicadors: IndicadorsService,
  ) {}

  /** Endpoint de prova: envia un missatge com els de TCP/MQTT */
  @Post('message')
  async envia(@Body() dto: MessageDto) {
    await this.stock.handleMessage(dto);
    await this.indicadors.handleMessage(dto);
    return { ok: true };
  }
}