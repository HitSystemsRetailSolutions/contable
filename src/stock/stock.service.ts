// ------------------------------------------------------------
// File: src/stock/stock.service.ts
// ------------------------------------------------------------
import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { MqttService } from '../mqtt/mqtt.service';
import * as moment from 'moment';
import { nomTaulaServit, nomTaulaVenut, nomTaulaEncarregs } from './utils/dates';
import { ControlData } from './types';

function dbg(...args: any[]) {
  if (process.env.DEBUG?.toLowerCase() === 'true') {
    Logger.debug(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  }
}

@Injectable()
export class StockService {
  private readonly estoc: Record<number, Record<string, ControlData>> = {};
  private readonly lastUpdate: Record<number, string> = {};

  constructor(
    private readonly db: DatabaseService,
    private readonly mqtt: MqttService,
  ) { }

  /** Punt d'entrada per MQTT o TCP */
  async handleMessage(data: any) {
    dbg('StockService.handleMessage', data);
    const tipus = data.Tipus || data.tipus || 'Venta';
    try {
      switch (tipus) {
        case 'ObreCaixa':
          dbg('ObreCaixa', data);
          await this.obreCaixa(data);
          break;
        case 'Venta':
          await this.revisaIndicadors(data);
          break;
        case 'Encarrec':
          await this.revisaIndicadors({ ...data, tipus: 'Encarrec' });
          break;
        default:
          Logger.warn(`Tipus desconegut: ${tipus}`);
      }
    } catch (err) {
      Logger.error('Error handleMessage', err);
    }
  }

  private async obreCaixa(data: any) {
    dbg('ObreCaixa', data);
    await this.initVectorLlicencia(data.Llicencia, data.Empresa, data.CaixaDataInici);
  }

  private async revisaIndicadors(data: any) {
    dbg('revisaIndicadors', data);
    if (!data || !Array.isArray(data.Articles)) {
      Logger.error('Dades incorrectes o sense articles');
      return;
    }
    try {
      // 1. Neteja de controls inactius (sense servides ni encarregades)
      Object.entries(this.estoc[data.Llicencia] || {})
        .filter(([_, c]) => c.tipus === 'Encarrecs') // només Encarrecs
        .forEach(([key, c]) => {
          if ((c.unitatsServides || 0) <= 0 && (c.unitatsEncarregades || 0) <= 0) {
            const topic = `${process.env.MQTT_CLIENT_ID}/Estock/${data.Llicencia}`;
            const emptyMsg = JSON.stringify({
              Llicencia: data.Llicencia,
              articleCodi: key,
              EstocActualitzat: '  ',
              FontSize: 12,
              FontColor: 'Black',
            });
            dbg('MQTT DELETE →', topic, emptyMsg);
            this.mqtt.publish(topic, emptyMsg);
            delete this.estoc[data.Llicencia][key];
          }
        });
      // 2. Carrega dades inicials
      const forceInit = data.tipus === 'Encarrec';
      await this.initVectorLlicencia(data.Llicencia, data.Empresa, forceInit ? new Date() : null);
      const tipus = data.tipus || 'Venta';

      // 3. Processa articles de la comanda
      data.Articles.forEach((art: any) => {
        const codi = Number(art.articleCodi || art.CodiArticle || 0);
        const quant = parseFloat(art.Quantitat || 0);
        const ctrl = this.estoc[data.Llicencia]?.[String(codi)];
        
        if (!ctrl || ctrl.tipus !== 'Encarrecs') return;
        
        if (tipus === 'Venta') {
          ctrl.unitatsVenudes = (ctrl.unitatsVenudes || 0) + quant;
        } else if (tipus === 'Encarrec') {
          if (quant > 0) {
            if ((ctrl.unitatsEncarregades || 0) === 0) {
              ctrl.unitatsEncarregades = quant;
            }
          } else {
            ctrl.unitatsEncarregades = (ctrl.unitatsEncarregades || 0) + quant;
          }
        }
      });

      // 4. Genera i publica missatges
      for (const key of Object.keys(this.estoc[data.Llicencia] || {})) {
        const ctrl = this.estoc[data.Llicencia][key];
        if (ctrl.tipus !== 'Encarrecs') continue;

        const noActivity = (ctrl.unitatsServides || 0) <= 0 && (ctrl.unitatsEncarregades || 0) <= 0;

        if (noActivity) {
          const topic = `${process.env.MQTT_CLIENT_ID}/Estock/${data.Llicencia}`;
          const emptyMsg = JSON.stringify({
            Llicencia: data.Llicencia,
            articleCodi: ctrl.articleCodi,
            EstocActualitzat: '  ',
            FontSize: 12,
            FontColor: 'Black',
          });
          dbg('MQTT DELETE →', topic, emptyMsg);
          this.mqtt.publish(topic, emptyMsg);
          delete this.estoc[data.Llicencia][key];
        } else {
          const msg = this.generaMissatge(ctrl, data.Llicencia);
          if (ctrl.ultimMissatge !== msg) {
            ctrl.ultimMissatge = msg;
            const topic = `${process.env.MQTT_CLIENT_ID}/Estock/${data.Llicencia}`;
            dbg('MQTT →', topic, msg);
            this.mqtt.publish(topic, msg);
          }
        }
      }
    } catch (error) {
      Logger.error('Error revisaIndicadors', error);
    }
  }

  private async initVectorLlicencia(Llicencia: number, Empresa: string, dataInici: Date | string | null = null) {
    dbg('initVectorLlicencia', { Llicencia, Empresa, dataInici });
    const avui = new Date();
    if (!dataInici) {
      const ultima = this.lastUpdate[Llicencia];
      if (ultima) {
        const dUltima = new Date(ultima);
        if (dUltima.toDateString() === avui.toDateString()) {
          dbg('Vector ja actualitzat avui');
          return;
        }
      }
    }
    this.lastUpdate[Llicencia] = avui.toISOString();
    const inici = dataInici ? new Date(dataInici) : new Date(avui.getFullYear(), avui.getMonth(), avui.getDate());
    const mesPasat = new Date(avui.getFullYear(), avui.getMonth() - 1, 1);
    const mesSeguent = new Date(avui.getFullYear(), avui.getMonth() + 1, 1);

    if (!this.estoc[Llicencia]) this.estoc[Llicencia] = {};

    // ENCARRECS
    if (['fac_demo', 'fac_camps'].includes(Empresa.toLowerCase())) {
      let crea = '';
      let unionSql = '';
      const dStart = moment().subtract(1, 'days');
      const dEnd = moment().add(31, 'days');
      for (let d = moment(dStart); d.isSameOrBefore(dEnd, 'day'); d.add(1, 'day')) {
        const table = nomTaulaServit(d.toDate());
        crea += `IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = '${nomTaulaServit(d.toDate())}')
                BEGIN
                  CREATE TABLE [dbo].[${nomTaulaServit(d.toDate())}] (
                        [Id] [uniqueidentifier] NULL,
                        [TimeStamp] [datetime] NULL,
                        [QuiStamp] [nvarchar](255) NULL,
                        [Client] [float] NULL,
                        [CodiArticle] [int] NULL,
                        [PluUtilitzat] [nvarchar](255) NULL,
                        [Viatge] [nvarchar](255) NULL,
                        [Equip] [nvarchar](255) NULL,
                        [QuantitatDemanada] [float] NULL,
                        [QuantitatTornada] [float] NULL,
                        [QuantitatServida] [float] NULL,
                        [MotiuModificacio] [nvarchar](255) NULL,
                        [Hora] [float] NULL,
                        [TipusComanda] [float] NULL,
                        [Comentari] [nvarchar](255) NULL,
                        [ComentariPer] [nvarchar](255) NULL,
                        [Atribut] [int] NULL,
                        [CitaDemanada] [nvarchar](255) NULL,
                        [CitaServida] [nvarchar](255) NULL,
                        [CitaTornada] [nvarchar](255) NULL
                      )
                END;
                `;
        unionSql += `UNION SELECT codiArticle as Article, SUM(QuantitatServida) as s, 0 as v, 0 as e
                FROM [${table}]
                WHERE client = ${Llicencia} AND quantitatServida > 0 AND TipusComanda != 2
                GROUP BY codiArticle
                `;
      }
      const query = `USE ${Empresa} ${crea}
              ${this.sqlCreaTaulesEncarrecs([avui, mesPasat, mesSeguent])}
              SELECT Article as codiArticle, ISNULL(SUM(s), 0) as UnitatsServides,
                     ISNULL(SUM(v), 0) as UnitatsVenudes, ISNULL(SUM(e), 0) as UnitatsEncarregades
              FROM (
                SELECT plu AS Article, 0 as s, SUM(quantitat) as v, 0 as e FROM [${nomTaulaVenut(avui)}] WHERE botiga = ${Llicencia} GROUP BY plu
                UNION
                SELECT plu AS Article, 0 as s, SUM(quantitat) as v, 0 as e FROM [${nomTaulaVenut(mesPasat)}] WHERE botiga = ${Llicencia} GROUP BY plu
                UNION
                SELECT Article, 0 as s, 0 as v, SUM(quantitat) as e FROM [${nomTaulaEncarregs(avui)}] WHERE botiga = ${Llicencia} AND estat = 0 GROUP BY article
                UNION
                SELECT Article, 0 as s, 0 as v, SUM(quantitat) as e FROM [${nomTaulaEncarregs(mesPasat)}] WHERE botiga = ${Llicencia} AND estat = 0 GROUP BY article
                UNION
                SELECT Article, 0 as s, 0 as v, SUM(quantitat) as e FROM [${nomTaulaEncarregs(mesSeguent)}] WHERE botiga = ${Llicencia} AND estat = 0 GROUP BY article
                ${unionSql}
              ) t
              GROUP BY Article
              HAVING 
              ISNULL(SUM(s), 0) > 0
              OR ISNULL(SUM(e), 0) > 0
              `;
      const res = await this.db.query(query);
      (res.recordset as any[]).forEach((row) => this.actualitzaEstoc(row, 'Encarrecs', Llicencia));
    }
  }

  /** Centralitza l'actualització del map estoc per a tots els tipus */
  private sqlCreaTaulesEncarrecs(dates: Date[]): string {
    const tables = [...new Set(dates.map((d) => nomTaulaEncarregs(d)))];
    return tables.map((table) => this.sqlCreaTaulaEncarrecs(table)).join('\n');
  }

  private sqlCreaTaulaEncarrecs(table: string): string {
    return `IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = '${table}')
              BEGIN
                CREATE TABLE [dbo].[${table}](
                  [Id] [nvarchar](255) NULL,
                  [Dependenta] [float] NULL,
                  [Client] [nvarchar](255) NULL,
                  [Data] [datetime] NULL,
                  [Estat] [float] NULL,
                  [Tipus] [float] NULL,
                  [Anticip] [float] NULL,
                  [Botiga] [float] NULL,
                  [Detall] [nvarchar](255) NULL,
                  [Periode] [nvarchar](255) NULL,
                  [Article] [float] NULL,
                  [Quantitat] [float] NULL,
                  [Import] [float] NULL,
                  [Descompte] [nvarchar](255) NULL,
                  [MarcatDesde] [nvarchar](255) NULL,
                  [Comentari] [nvarchar](255) NULL,
                  [Importat] [nvarchar](255) NULL
                )
              END;
              `;
  }

  private actualitzaEstoc(row: any, tipus: ControlData['tipus'], Llicencia: number) {
    const cd = String(row.codiArticle || row.Article);
    const prev = this.estoc[Llicencia][cd] ?? ({ actiu: false, tipus, articleCodi: cd, ultimMissatge: '' } as ControlData);
    let ctl: ControlData;
    if (tipus === 'Encarrecs') {
      const est = Number(row.UnitatsServides) - Number(row.UnitatsVenudes) - Number(row.UnitatsEncarregades);
      ctl = { ...prev, actiu: true, tipus, articleCodi: cd, ultimMissatge: '', estoc: est, unitatsServides: Number(row.UnitatsServides), unitatsVenudes: Number(row.UnitatsVenudes), unitatsEncarregades: Number(row.UnitatsEncarregades) };
    } else {
      ctl = prev;
    }
    this.estoc[Llicencia][cd] = ctl;
  }

  private generaMissatge(ctrl: ControlData, Llicencia: number): string {
    if (ctrl.tipus === 'Encarrecs') {
        return this.generaMissatgeEncarrecs(ctrl, Llicencia);
    }
    return ctrl.ultimMissatge;
  }

  private generaMissatgeEncarrecs(ctrl: ControlData, Llicencia: number): string {
    const est = (ctrl.unitatsServides || 0) - (ctrl.unitatsVenudes || 0) - (ctrl.unitatsEncarregades || 0);
    ctrl.estoc = est;
    ctrl.ultimMissatge = '';
    let emoji = '';
    if (est < 0) emoji = '🤢';
    else emoji = '🍒'.repeat(Math.min(5, Math.floor(est)));
    const text = `${emoji}${est} = ${ctrl.unitatsServides} - ${ctrl.unitatsVenudes} - ${ctrl.unitatsEncarregades}`;
    const color = est < 0 ? 'Red' : est === 0 ? 'Green' : 'Black';
    const size = est < 0 ? 16 : 12;
    return JSON.stringify({
      Llicencia,
      articleCodi: ctrl.articleCodi,
      EstocActualitzat: text,
      FontSize: size,
      FontColor: color,
    });
  }
}

