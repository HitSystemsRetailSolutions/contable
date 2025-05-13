// ------------------------------------------------------------
// File: src/stock/stock.service.ts
// ------------------------------------------------------------
import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { MqttService } from '../mqtt/mqtt.service';
import * as moment from 'moment';
import { nomTaulaServit, nomTaulaVenut, nomTaulaEncarregs, nomTaulaCompromiso } from './utils/dates';

function dbg(...args: any[]) {
  if (process.env.DEBUG?.toLowerCase() === 'true') {
    Logger.debug(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  }
}

interface ControlData {
  actiu: boolean;
  tipus: 'Encarrecs' | 'Compromisos' | 'IndicadorVenut';
  articleCodi: number | string;
  ultimMissatge: string;
  // per Encarrecs
  estoc?: number;
  unitatsVenudes?: number;
  unitatsServides?: number;
  unitatsEncarregades?: number;
  // per Compromisos/IndicadorVenut
  historic?: Array<{ Minut: number; SumaAvui: number; SumaPast: number }>;
  minutCalcul?: number;
  objectiu?: number;
  unitatsVenudes7d?: number;
  importVenut?: number;
  importVenut7d?: number;
}

@Injectable()
export class StockService {
  private readonly estoc: Record<number, Record<string, ControlData>> = {};
  private readonly lastUpdate: Record<number, string> = {};

  constructor(
    private readonly db: DatabaseService,
    private readonly mqtt: MqttService,
  ) {}

  /** Punt d'entrada per MQTT o TCP */
  async handleMessage(data: any) {
    dbg('handleMessage', data);
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
      const minutCalcul = new Date().getHours() * 60 + new Date().getMinutes();
      let importTotalTicket = 0;
      const tipus = data.tipus || 'Venta';

      // 3. Processa articles de la comanda
      data.Articles.forEach((art: any) => {
        const codi = Number(art.articleCodi || art.CodiArticle || 0);
        const quant = parseFloat(art.Quantitat || 0);
        const imp = parseFloat(art.import || 0);
        const ctrl = this.estoc[data.Llicencia]?.[String(codi)];
        dbg('Article', codi, 'quant', quant, 'import', imp, 'ctrl', ctrl);
        if (!ctrl) return;
        if (tipus === 'Venta') {
          // Acumula imports i vendes
          importTotalTicket += imp;
          ctrl.unitatsVenudes = (ctrl.unitatsVenudes || 0) + quant;
        } else if (tipus === 'Encarrec') {
          // Evitar doble comptatge en el primer encàrrec: només sumar quant si no hi ha cap reserva prèvia
          if (quant > 0) {
            if ((ctrl.unitatsEncarregades || 0) === 0) {
              ctrl.unitatsEncarregades = quant;
            }
          } else {
            // Sempre aplicar anul·lacions (quant negatiu)
            ctrl.unitatsEncarregades = (ctrl.unitatsEncarregades || 0) + quant;
          }
        }
      });

      // 4. Genera i publica missatges
      for (const key of Object.keys(this.estoc[data.Llicencia] || {})) {
        const ctrl = this.estoc[data.Llicencia][key];
        const noActivity = ctrl.tipus === 'Encarrecs' && (ctrl.unitatsServides || 0) <= 0 && (ctrl.unitatsEncarregades || 0) <= 0;

        if (noActivity) {
          // Encàrrec totalment anul·lat: missatge buit
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
          // Missatge estàndard per a vendes i encàrrecs actius
          const msg = this.generaMissatge(ctrl, minutCalcul, importTotalTicket, data.Llicencia);
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
    if (!this.estoc[Llicencia]) this.estoc[Llicencia] = {};

    const mesPasat = new Date(avui.getFullYear(), avui.getMonth() - 1, 1);
    const minutCalcul = avui.getHours() * 60 + avui.getMinutes();

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
                WHERE client = ${Llicencia} AND quantitatServida > 0 AND TipusComanda = 1
                GROUP BY codiArticle
                `;
      }
      const query = `USE ${Empresa} ${crea}
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
    // COMPROMISOS + INDICADORS
    await this.actualitzaCompromisos(Llicencia, Empresa, avui, minutCalcul);
  }
  /** Centralitza l'actualització del map estoc per a tots els tipus */
  private actualitzaEstoc(row: any, tipus: ControlData['tipus'], Llicencia: number) {
    const cd = String(row.codiArticle || row.Article);
    const prev = this.estoc[Llicencia][cd] ?? ({ actiu: false, tipus, articleCodi: cd, ultimMissatge: '', historic: [] } as ControlData);
    let ctl: ControlData;
    if (tipus === 'Encarrecs') {
      const est = Number(row.UnitatsServides) - Number(row.UnitatsVenudes) - Number(row.UnitatsEncarregades);
      ctl = { ...prev, actiu: true, tipus, articleCodi: cd, ultimMissatge: '', estoc: est, unitatsServides: Number(row.UnitatsServides), unitatsVenudes: Number(row.UnitatsVenudes), unitatsEncarregades: Number(row.UnitatsEncarregades) };
    } else {
      // Compromisos i IndicadorVenut es processen més endavant
      ctl = prev;
    }
    this.estoc[Llicencia][cd] = ctl;
  }
  private async actualitzaCompromisos(Llicencia: number, Empresa: string, avui: Date, minutCalcul: number) {
    const last = moment().subtract(7, 'days');
    const taComp = nomTaulaCompromiso(avui);
    const taAvui = nomTaulaVenut(avui);
    const taSet = nomTaulaVenut(last.toDate());
    const existQ = `USE ${Empresa}; 
                    IF EXISTS(SELECT*FROM sys.tables WHERE name='${taComp}') 
                    AND EXISTS(SELECT*FROM sys.tables WHERE name='${taAvui}') 
                    AND EXISTS(SELECT*FROM sys.tables WHERE name='${taSet}') 
                    SELECT 1`;
    const ex = await this.db.query(existQ);
    // Si no hi ha recordset o és buit, sortim
    if (!ex?.recordset || ex.recordset.length === 0) return;

    const objQ = `USE ${Empresa};
      SELECT 
        plu AS codiArticle,
        objectiu AS Objectiu,
        Min * 30 AS Minut,
        SUM(CASE WHEN T = 'Avui' THEN quantitat ELSE 0 END) AS SumaAvui,
        SUM(CASE WHEN T = 'Past' THEN quantitat ELSE 0 END) AS SumaPast
      FROM (
        SELECT 'Avui' AS T, v.plu, objectiu,
          DATEDIFF(MINUTE, CAST(v.data AS DATE), v.data) / 30 AS Min,
          SUM(v.quantitat) AS quantitat
        FROM (
          SELECT comentaris AS plu, objectiu
          FROM [${taComp}]
          WHERE dia = '${moment(avui).format('YYYY-MM-DD')}' AND botiga = ${Llicencia}
        ) o
        JOIN [${taAvui}] v ON v.plu = o.plu AND v.Botiga = ${Llicencia} AND DAY(v.data) = ${moment().date()}
        GROUP BY DATEDIFF(MINUTE, CAST(v.data AS DATE), v.data) / 30, objectiu, v.plu

        UNION ALL

        SELECT 'Past' AS T, v.plu, objectiu,
          DATEDIFF(MINUTE, CAST(v.data AS DATE), v.data) / 30 AS Min,
          SUM(v.quantitat) AS quantitat
        FROM (
          SELECT comentaris AS plu, objectiu
          FROM [${taComp}]
          WHERE dia = '${moment(avui).format('YYYY-MM-DD')}' AND botiga = ${Llicencia}
        ) o
        JOIN [${taSet}] v ON v.plu = o.plu AND v.Botiga = ${Llicencia} AND DAY(v.data) = ${last.date()}
        GROUP BY DATEDIFF(MINUTE, CAST(v.data AS DATE), v.data) / 30, objectiu, v.plu
      ) a
      GROUP BY plu, objectiu, Min
      ORDER BY plu, objectiu, Min;
    `;
    const rez = await this.db.query(objQ);
    (rez.recordset as any[]).forEach((row) => {
      const cd = String(row.codiArticle);
      // reutilitzem actualitzaEstoc per Compromisos
      this.actualitzaEstoc({ codiArticle: cd, UnitatsServides: 0, UnitatsVenudes: 0, UnitatsEncarregades: 0 }, 'Compromisos', Llicencia);
      // Després actualitzem dades específiques
      const prev = this.estoc[Llicencia][cd];
      const newHist = [...(prev.historic || []), { Minut: row.Minut, SumaAvui: row.SumaAvui, SumaPast: row.SumaPast }];
      prev.historic = newHist;
      prev.minutCalcul = minutCalcul;
      prev.objectiu = Number(row.Objectiu);
      prev.unitatsVenudes7d = (prev.unitatsVenudes7d || 0) + (row.Minut < minutCalcul ? row.SumaPast : 0);
      prev.unitatsVenudes = (prev.unitatsVenudes || 0) + row.SumaAvui;
    });

    // IndicadorVenut: similar a compromisos però amb imports
    const indQ = `USE ${Empresa}; SELECT Min * 30 AS Minut, SUM(CASE WHEN T='Avui' THEN import ELSE 0 END) AS SumaAvui, SUM(CASE WHEN T='Past' THEN import ELSE 0 END) AS SumaPast FROM ( SELECT 'Avui' AS T, DATEDIFF(MINUTE, CAST(v.data AS DATE), v.data)/30 AS Min, SUM(v.import) AS import FROM [${taAvui}] v WHERE v.Botiga=${Llicencia} AND DAY(v.data)=${moment().date()} GROUP BY DATEDIFF(MINUTE, CAST(v.data AS DATE), v.data)/30 UNION ALL SELECT 'Past' AS T, DATEDIFF(MINUTE, CAST(v.data AS DATE), v.data)/30 AS Min, SUM(v.import) AS import FROM [${taSet}] v WHERE v.Botiga=${Llicencia} AND DAY(v.data)=${last.date()} GROUP BY DATEDIFF(MINUTE, CAST(v.data AS DATE), v.data)/30 ) a GROUP BY Min ORDER BY Min`;
    const resInd = await this.db.query(indQ);
    const key = 'IndicadorPos1';
    // Prepara control
    if (!this.estoc[Llicencia][key]) {
      this.estoc[Llicencia][key] = { actiu: true, tipus: 'IndicadorVenut', articleCodi: key, ultimMissatge: '', historic: [], importVenut: 0, importVenut7d: 0 };
    }
    const ctrl = this.estoc[Llicencia][key];
    resInd.recordset.forEach((row: any) => this.actualitzaEstoc({ codiArticle: key }, 'IndicadorVenut', Llicencia));
  }

  private generaMissatge(ctrl: ControlData, minutCalcul: number, importTotalTicket: number, Llicencia: number): string {
    switch (ctrl.tipus) {
      case 'Encarrecs':
        return this.generaMissatgeEncarrecs(ctrl, Llicencia);
      case 'Compromisos':
        return this.generaMissatgeCompromisos(ctrl, minutCalcul, Llicencia);
      case 'IndicadorVenut':
        return this.generaMissatgeIndicadorVenut(ctrl, minutCalcul, importTotalTicket, Llicencia);
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

  private generaMissatgeCompromisos(ctrl: ControlData, minutCalcul: number, Llicencia: number): string {
    (ctrl.historic || []).forEach((h) => {
      if (h.Minut > (ctrl.minutCalcul || 0) && minutCalcul > (ctrl.minutCalcul || 0)) {
        ctrl.unitatsVenudes7d = (ctrl.unitatsVenudes7d || 0) + h.SumaPast;
        ctrl.minutCalcul = h.Minut;
      }
    });
    const dif = Math.floor((ctrl.unitatsVenudes || 0) - (ctrl.objectiu || 0));
    let emoji = '💩';
    if (dif >= 1) emoji = '😃';
    else if (dif >= -5) emoji = '🍒'.repeat(Math.abs(dif));
    else if (dif < -5) emoji = '🤢';
    return JSON.stringify({
      Llicencia,
      articleCodi: ctrl.articleCodi,
      EstocActualitzat: emoji,
      FontSize: 20,
      FontColor: 'Black',
    });
  }

  private generaMissatgeIndicadorVenut(ctrl: ControlData, minutCalcul: number, importTotal: number, Llicencia: number): string {
    ctrl.articleCodi = 'IndicadorPos1';
    ctrl.importVenut = (ctrl.importVenut || 0) + importTotal;
    (ctrl.historic || []).forEach((h) => {
      if (h.Minut > (ctrl.minutCalcul || 0) && minutCalcul > (ctrl.minutCalcul || 0)) {
        ctrl.importVenut7d = (ctrl.importVenut7d || 0) + h.SumaPast;
        ctrl.importVenut = (ctrl.importVenut || 0) + h.SumaAvui;
        ctrl.minutCalcul = h.Minut;
      }
    });
    const dif = Math.floor(((ctrl.importVenut || 0) / (ctrl.importVenut7d || 1)) * 100) - 100;
    const importDiff = Math.round((ctrl.importVenut || 0) - (ctrl.importVenut7d || 0));
    const emojis = ['🤑', '😃', '😄', '😒', '😥', '😳', '😟', '💩', '😠', '😡', '🤬', '🤢', '🤢'];
    let idx = 5;
    if (dif > 20) idx = 0;
    else if (dif > 10) idx = 1;
    else if (dif > 0) idx = 2;
    else if (dif > -5) idx = 3;
    else if (dif > -10) idx = 4;
    else if (dif > -15) idx = 5;
    else if (dif > -18) idx = 6;
    else if (dif > -20) idx = 7;
    else if (dif > -22) idx = 8;
    else if (dif > -24) idx = 9;
    else if (dif > -25) idx = 10;
    else if (dif > -30) idx = 11;
    else idx = 12;
    let color = 'Black',
      size = 17;
    if (dif < 0) {
      color = 'Red';
      size = 20;
    }
    return JSON.stringify({
      Llicencia,
      articleCodi: ctrl.articleCodi,
      EstocActualitzat: `${emojis[idx]} ${importDiff}`,
      FontSize: size,
      FontColor: color,
    });
  }
}
