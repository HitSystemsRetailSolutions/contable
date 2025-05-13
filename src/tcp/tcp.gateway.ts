import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createServer, Socket } from 'net';
import { StockService } from '../stock/stock.service';

@Injectable()
export class TcpGateway implements OnModuleInit {
  constructor(private readonly stock: StockService) {}

  onModuleInit() {
    const server = createServer();

    server.on('connection', (socket: Socket) => {
      Logger.debug('➕ Client TCP connectat');
      socket.on('data', async (buf) => {
        try {
          const msg = JSON.parse(buf.toString());
          await this.stock.handleMessage(msg);
          socket.write(
            JSON.stringify({ status: 'success', message: 'Missatge OK' }),
          );
        } catch (err) {
          Logger.error('❌ Error al socket TCP', err);
          socket.write(
            JSON.stringify({ status: 'error', message: err.message }),
          );
        }
      });
      socket.on('end', () => Logger.debug('➖ Client TCP desconnectat'));
    });

    server.listen(3039, () =>
      Logger.log('🚀 Servidor TCP escoltant al port 3039'),
    );
  }
}
