import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { MqttService } from '../mqtt/mqtt.service';
import * as moment from 'moment';
import { nomTaulaVenut, nomTaulaCompromiso } from './utils/dates';
import { ControlData } from './types';
import { pctCara } from './utils/cara';

function dbg(...args: any[]) {
  if (process.env.DEBUG?.toLowerCase() === 'true') {
    Logger.debug(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  }
}

@Injectable()
export class IndicadorsService {
  private readonly estoc: Record<number, Record<string, ControlData>> = {};
  private readonly lastUpdate: Record<number, string> = {};

  constructor(
    private readonly db: DatabaseService,
    private readonly mqtt: MqttService,
  ) { }

  async handleMessage(data: any) {
    dbg('IndicadorsService.handleMessage', data);
    const tipus = data.Tipus || data.tipus || 'Venta';
    if (tipus === 'Venta') {
      await this.revisaIndicadors(data);
    }
  }

  private async revisaIndicadors(data: any) {
    dbg('IndicadorsService.revisaIndicadors', data);
    if (!data || !Array.isArray(data.Articles)) {
      return;
    }
    try {
      await this.initVectorLlicencia(data.Llicencia, data.Empresa);
      const minutCalcul = new Date().getHours() * 60 + new Date().getMinutes();
      let importTotalTicket = 0;

      data.Articles.forEach((art: any) => {
        const imp = parseFloat(art.import || 0);
        importTotalTicket += imp;
      });

      const ctrl = this.estoc[data.Llicencia]?.['IndicadorPos1'];
      if (ctrl) {
        const msg = this.generaMissatge(ctrl, minutCalcul, importTotalTicket, data.Llicencia);
        if (ctrl.ultimMissatge !== msg) {
          ctrl.ultimMissatge = msg;
          const topic = `${process.env.MQTT_CLIENT_ID}/Estock/${data.Llicencia}`;
          dbg('Indicadors MQTT →', topic, msg);
          this.mqtt.publish(topic, msg);
        }
      }
    } catch (error) {
      Logger.error('Error IndicadorsService.revisaIndicadors', error);
    }
  }

  private async initVectorLlicencia(Llicencia: number, Empresa: string) {
    const avui = new Date();
    const ultima = this.lastUpdate[Llicencia];
    const key = 'IndicadorPos1';

    // Si ja s'ha actualitzat avui I ja tenim l'indicador, no fem res.
    // Si falta l'indicador (perquè abans ha fallat la comprovació de taules), forcem actualització.
    if (ultima && this.estoc[Llicencia]?.[key]) {
      const dUltima = new Date(ultima);
      if (dUltima.toDateString() === avui.toDateString()) {
        return;
      }
    }
    this.lastUpdate[Llicencia] = avui.toISOString();

    if (!this.estoc[Llicencia]) this.estoc[Llicencia] = {};
    const minutCalcul = avui.getHours() * 60 + avui.getMinutes();
    await this.actualitzaIndicadors(Llicencia, Empresa, avui, minutCalcul);
  }

  private async actualitzaIndicadors(Llicencia: number, Empresa: string, avui: Date, minutCalcul: number) {
    const last = moment().subtract(7, 'days');
    const taAvui = nomTaulaVenut(avui);
    const taSet = nomTaulaVenut(last.toDate());

    const existVenutQ = `USE ${Empresa}; IF EXISTS(SELECT*FROM sys.tables WHERE name='${taAvui}') AND EXISTS(SELECT*FROM sys.tables WHERE name='${taSet}') SELECT 1`;
    const exVenut = await this.db.query(existVenutQ);

    if (exVenut?.recordset && exVenut.recordset.length > 0) {
      const indQ = `
        USE ${Empresa};
        -- Obtenim l'estat actual d'avui (TOTAL)
        SELECT 
          SUM(import) AS SumaAvui,
          COUNT(DISTINCT Num_tick) AS ClientsAvui
        FROM [${taAvui}]
        WHERE Botiga=${Llicencia} AND DAY(data)=${moment().date()} AND Tipus_venta='V';

        -- Obtenim l'històric de fa 7 dies per blocs (però agrupant tickets primer per evitar duplicats)
        SELECT 
          Min * 30 AS Minut,
          SUM(import) AS SumaPast,
          COUNT(DISTINCT Num_tick) AS ClientsPast
        FROM (
          SELECT 
            Num_tick, 
            SUM(import) AS import, 
            MAX(DATEDIFF(MINUTE, CAST(data AS DATE), data) / 30) AS Min
          FROM [${taSet}]
          WHERE Botiga=${Llicencia} AND DAY(data)=${last.date()} AND Tipus_venta='V'
          GROUP BY Num_tick
        ) t
        GROUP BY Min
        ORDER BY Min;
      `;
      const multiRez = await this.db.query(indQ);
      const key = 'IndicadorPos1';
      if (!this.estoc[Llicencia][key]) {
        this.estoc[Llicencia][key] = { actiu: true, tipus: 'IndicadorVenut', articleCodi: key, ultimMissatge: '', historic: [], importVenut: 0, importVenut7d: 0, clientsVenut: 0, clientsVenut7d: 0 };
      }
      const ctrl = this.estoc[Llicencia][key];

      // Resultat 1: Estat actual d'avui
      if (multiRez.recordsets && multiRez.recordsets[0]?.length > 0) {
        const row = multiRez.recordsets[0][0] as any;
        ctrl.importVenut = row.SumaAvui || 0;
        ctrl.clientsVenut = row.ClientsAvui || 0;
      }

      // Resultat 2: Històric de fa 7 dies
      ctrl.historic = [];
      ctrl.importVenut7d = 0;
      ctrl.clientsVenut7d = 0;
      if (multiRez.recordsets && multiRez.recordsets[1]?.length > 0) {
        multiRez.recordsets[1].forEach((row: any) => {
          if (ctrl.historic) {
            ctrl.historic.push({ Minut: row.Minut, SumaAvui: 0, SumaPast: row.SumaPast, ClientsAvui: 0, ClientsPast: row.ClientsPast } as any);
          }
          if (row.Minut < minutCalcul) {
            ctrl.importVenut7d = (ctrl.importVenut7d || 0) + (row.SumaPast || 0);
            ctrl.clientsVenut7d = (ctrl.clientsVenut7d || 0) + (row.ClientsPast || 0);
          }
        });
      }
      ctrl.minutCalcul = minutCalcul;
    }
  }

  private generaMissatge(ctrl: ControlData, minutCalcul: number, importTotalTicket: number, Llicencia: number): string {
    if (ctrl.tipus === 'IndicadorVenut') {
      return this.generaMissatgeIndicadorVenut(ctrl, minutCalcul, importTotalTicket, Llicencia);
    }
    return ctrl.ultimMissatge;
  }

  private generaMissatgeIndicadorVenut(ctrl: ControlData, minutCalcul: number, importTotal: number, Llicencia: number): string {
    ctrl.articleCodi = 'IndicadorPos1';

    // 1. Incrementem en memòria (per estalviar SQL)
    if (importTotal > 0) {
      ctrl.importVenut = (ctrl.importVenut || 0) + importTotal;
      ctrl.clientsVenut = (ctrl.clientsVenut || 0) + 1;
    }

    // 2. Actualitzem la referència històrica a mesura que passa el temps
    (ctrl.historic || []).forEach((h: any) => {
      if (h.Minut > (ctrl.minutCalcul || 0) && h.Minut < minutCalcul) {
        ctrl.importVenut7d = (ctrl.importVenut7d || 0) + (h.SumaPast || 0);
        ctrl.clientsVenut7d = (ctrl.clientsVenut7d || 0) + (h.ClientsPast || 0);
      }
    });
    ctrl.minutCalcul = minutCalcul;

    // 3. Càlcul d'indicadors
    const v1 = ctrl.importVenut7d || 0;
    const v2 = ctrl.importVenut || 0;
    const emojiV = pctCara(v1, v2);
    const pV = v1 > 0 ? ((v2 / v1) - 1) * 100 : (v2 > 0 ? 100 : 0);

    const c1 = ctrl.clientsVenut7d || 0;
    const c2 = ctrl.clientsVenut || 0;
    const emojiC = pctCara(c1, c2);
    const pC = c1 > 0 ? ((c2 / c1) - 1) * 100 : (c2 > 0 ? 100 : 0);

    const tm1 = c1 > 0 ? v1 / c1 : 0;
    const tm2 = c2 > 0 ? v2 / c2 : 0;
    const emojiTM = pctCara(tm1, tm2);
    const pM = tm1 > 0 ? ((tm2 / tm1) - 1) * 100 : (tm2 > 0 ? 100 : 0);

    dbg(`Indicadors Valors [${Llicencia}]: Ventas(${v1.toFixed(2)}->${v2.toFixed(2)}) Clients(${c1}->${c2})`);

    const text = `V:${emojiV}${pV > 0 ? '+' : ''}${pV.toFixed(0)}% C:${emojiC}${pC > 0 ? '+' : ''}${pC.toFixed(0)}% M:${emojiTM}${pM > 0 ? '+' : ''}${pM.toFixed(0)}%`;

    let color = 'Black', size = 16;
    const p = (1 - v1 / v2) * 100;
    if (p <= 0) {
      color = 'Red';
      size = 18;
    }

    return JSON.stringify({
      Llicencia,
      articleCodi: ctrl.articleCodi,
      EstocActualitzat: text,
      FontSize: size,
      FontColor: color,
    });
  }
}
