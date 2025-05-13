import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as mqtt from 'mqtt';

@Injectable()
export class MqttService implements OnModuleInit {
  private client!: mqtt.MqttClient;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const opts = this.config.get('mqtt');
    this.client = mqtt.connect({
      host: opts.host,
      port: opts.port,
      username: opts.username,
      password: opts.password,
      clientId: opts.clientId,
    });

    this.client
      .on('connect', () =>
        Logger.log(`✅ MQTT connectat a ${opts.host}`),
      )
      .on('reconnect', () => Logger.warn('🔄 Reintentant connexió MQTT…'))
      .on('close', () => Logger.warn('🔌 Connexió MQTT tancada'))
      .on('error', (err) => Logger.error('❌ Error MQTT', err));

    // Subscripció per defecte
    this.client.subscribe(`${opts.clientId}/Conta/#`, { qos: 1 });
  }

  publish(topic: string, payload: string | Buffer) {
    this.client.publish(topic, payload);
  }

  on(pattern: string | RegExp, handler: (topic: string, msg: Buffer) => void) {
    this.client.on('message', (topic, message) => {
      if (typeof pattern === 'string' ? topic === pattern : pattern.test(topic)) {
        handler(topic, message);
      }
    });
  }
}