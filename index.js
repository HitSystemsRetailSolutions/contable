import { test, describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import mqtt from 'mqtt';
import sql from 'mssql';
import moment from 'moment';
import 'dotenv/config';
import net from 'net';

const DEBUG = process.env.DEBUG?.toLowerCase() === 'true';

function log(...args) {
  // Unifica logs i afegeix marca temporal
  const stamp = new Date().toLocaleString();
  console.log(stamp, ...args);
}
function dbg(...args) {
  if (DEBUG) log('[DEBUG]', ...args);
}

// Configuració de la connexió a la base de dades MSSQL
const dbConfig = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_SERVER,
  database: process.env.DB_DATABASE,
  options: {
    encrypt: false, // Per a Azure
    trustServerCertificate: true, // Només per a desenvolupament
  },
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 15000,
  },
  requestTimeout: 10000,
};

// Configuració del client MQTT
const mqttOptions = {
  host: process.env.MQTT_HOST,
  port: process.env.MQTT_PORT,
  username: process.env.MQTT_USER,
  password: process.env.MQTT_PASSWORD,
};

// Dades emmagatzemades en memòria
let estocPerLlicencia = {};

/******************************* MQTT ****************************************/
// Connexió al servidor MQTT
log('➜ Iniciant client MQTT…');
const client = mqtt.connect(mqttOptions);
// si estem en debug, informem del url user i psw al que ens entem conectant per console.log

client.on('connect', () => {
  log('✅ Connectat al servidor MQTT', process.env.MQTT_HOST);
  // Subscripció al topic desitjat

  client.subscribe(process.env.MQTT_CLIENT_ID + '/Conta/#', { qos: 1 }, (err) => {
    if (!err) {
      log('📡 Subscrit al topic:', process.env.MQTT_CLIENT_ID + "/Conta/#");
    } else {
      log('❌ Error al subscriure al topic:', err);
    }
  });
});

client.on('reconnect', () => log('🔄 Reintentant connexió MQTT…'));
client.on('close', () => log('🔌 Connexió MQTT tancada'));
client.on('offline', () => log('📴 Client MQTT offline'));
client.on('error', (err) => log('❌ Error MQTT:', err));

// Manejador per a missatges rebuts
client.on('message', (topic, missatge) => {
  dbg('← Missatge rebut per topic', topic, '\n', missatge.toString());
  process.stdout.write('📡');
  let data;
  try {
    data = JSON.parse(missatge);
  } catch (parseError) {
    log('❌ Error parsejant JSON del missatge MQTT:', parseError);
    return; // Si hi ha un error, aturem l'execució aquí i retornem
  }
  tractaMissatge(data);
});

// Creem un servidor TCP al port 3039
const server = net.createServer();

server.listen(3039, () => {
  log('🚀 Servidor TCP escoltant al port 3039');
});

server.on('connection', (socket) => {
  dbg('➕ Client TCP connectat');

  socket.on('data', (data) => {
    dbg('← Trama TCP rebuda', data.toString());
    process.stdout.write('📡');
    let missatge;
    try {
      // Convertim les dades a JSON
      missatge = JSON.parse(data);

      // Processem el missatge
      tractaMissatge(missatge);

      // Enviem resposta al client
      socket.write(JSON.stringify({ status: 'success', message: 'Missatge rebut i processat correctament' }));
    } catch (parseError) {
      log('❌ Error al processar el missatge:', parseError);
      // Resposta d'error al client
      socket.write(JSON.stringify({ status: 'error', message: 'Error al analitzar el missatge com a JSON' }));
    }
  });

  socket.on('end', () => dbg('➖ Client TCP desconnectat'));
  socket.on('error', (err) => log('❌ Error al socket TCP:', err));
});

// Gestionem errors del servidor

server.on('error', (err) => log('❌ Error servidor TCP:', err));

/******************************* FUNCIONS PRINCIPALS *************************/
async function tractaMissatge(data) {
  dbg('▶️  Entra a tractaMissatge amb', data);
  const tipus = data.tipus || 'Venta';
  try {
    const now = new Date();
    switch (tipus) {
      case 'ObreCaixa':
        dbg('⚙️  Tipus ObreCaixa');
        process.stdout.write('🏷️ ');
        ObreCaixa(data);
        break;

      case 'Venta':
        dbg('🛒 Tipus Venta');
        process.stdout.write('🛒 ');
        revisaIndicadors(data);
        break;

      case 'Encarrec':
        dbg('⏰ Tipus Encarrec');
        process.stdout.write('⏰ ');
        await initVectorLlicencia(data.Llicencia, data.Empresa, now);
        revisaIndicadors(data);
        break;

      default:
        log('❗ Tipus de missatge desconegut:', tipus);
    }
  } catch (error) {
    log('❌ Error a tractaMissatge:', error);
    throw error;
  }
  dbg('⏹️ Fi tractaMissatge', tipus);
}


/******************************* AUXILIARS DATES *****************************/

function formatData(d, format = 'YY-MM-DD') {
  const yearFull = d.getFullYear().toString();
  const yearShort = yearFull.slice(-2);
  const month = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');

  switch (format) {
    case 'YY-MM-DD':
      return `${yearShort}-${month}-${day}`;
    case 'YYYY-MM':
      return `${yearFull}-${month}`;
    case 'YYYY_MM':
      return `${yearFull}_${month}`;
    default:
      throw new Error(`Format de data desconegut: ${format}`);
  }
}

function nomTaulaServit(data) {
  // Format: Servit-24-02-10
  return `Servit-${formatData(data, 'YY-MM-DD')}`;
}

function nomTaulaVenut(data) {
  // Format: V_Venut_2024-02
  return `V_Venut_${formatData(data, 'YYYY-MM')}`;
}

function nomTaulaEncarregs(data) {
  // Format: V_Encarre_2024-02
  return `V_Encarre_${formatData(data, 'YYYY-MM')}`;
}

function nomTaulaCompromiso(data) {
  // Format: Compromiso_2024_02
  return `Compromiso_${formatData(data, 'YYYY_MM')}`;
}


async function initVectorLlicencia(Llicencia, Empresa, dataInici = null) {
  dbg('🔄 initVectorLlicencia', { Llicencia, Empresa, dataInici });
  const avui = new Date();
  const dataIniciUsada = dataInici ? new Date(dataInici) : new Date(avui.getFullYear(), avui.getMonth(), avui.getDate(), 0, 0, 0);
  try {
    // Evita recálculo si ya se actualizó hoy
    if (!dataInici && estocPerLlicencia[Llicencia]?.LastUpdate && new Date(estocPerLlicencia[Llicencia].LastUpdate).toDateString() === avui.toDateString()) {
      dbg('⏩ Vector llicència ja actualitzat avui');
      return;
    }
    // Si sql no esta conectat la conectem i esperem a que estigui conectat
    if (!sql.connected) {
      dbg('🖇️  Connectant a MSSQL…');
      await sql.connect(dbConfig);
      dbg('✅ Connexió MSSQL establerta');
    }

    const mesPasat = new Date(avui.getFullYear(), avui.getMonth() - 1, 1);
    const minutCalcul = avui.getHours() * 60 + Math.floor(avui.getMinutes());

    estocPerLlicencia[Llicencia] = estocPerLlicencia[Llicencia] || {};
    estocPerLlicencia[Llicencia]["LastUpdate"] = new Date().toISOString();

    let sqlSt = '';

    // --- GESTIÓ ENCÀRRECS ---
    if (["fac_demo", "fac_camps"].includes(Empresa.toLowerCase())) {
      const dataInici = moment().subtract(1, 'days');
      const dataFi = moment().add(31, 'days');
      let crea = '';

      for (let d = moment(dataInici); d.isSameOrBefore(dataFi, 'day'); d.add(1, 'day')) {
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

        sqlSt += `UNION SELECT codiArticle as Article, SUM(QuantitatServida) as s, 0 as v, 0 as e
                FROM [${nomTaulaServit(d.toDate())}]
                WHERE client = ${Llicencia} AND quantitatServida > 0 AND TipusComanda = 1
                GROUP BY codiArticle
                `;
      }

      sqlSt = `USE ${Empresa} ${crea}
              SELECT Article as codiArticle, ISNULL(SUM(s), 0) as UnitatsServides,
                     ISNULL(SUM(v), 0) as UnitatsVenudes, ISNULL(SUM(e), 0) as UnitatsEncarregades
              FROM (
                SELECT plu AS Article, 0 as s, SUM(quantitat) as v, 0 as e FROM [${nomTaulaVenut(avui)}] WHERE botiga = ${Llicencia} GROUP BY plu
                UNION
                SELECT plu AS Article, 0 as s, SUM(quantitat) as v, 0 as e FROM [${nomTaulaVenut(mesPasat)}] WHERE botiga = ${Llicencia} GROUP BY plu
                UNION
                SELECT Article, 0 as s, 0 as v, SUM(quantitat) as e FROM [${nomTaulaEncarregs(avui)}] WHERE botiga = ${Llicencia} AND estat = 0 GROUP BY article
                ${sqlSt}
              ) t
              GROUP BY Article
              `;

      let result = await sql.query(sqlSt);
      dbg('Resultat SQL', result.recordset.length, 'articles trobats');

      for (const row of result.recordset) {
        if (row.UnitatsServides > 0 || row.UnitatsEncarregades > 0) {
          estocPerLlicencia[Llicencia][row.codiArticle] = {
            actiu: true,
            tipus: 'Encarrecs',
            articleCodi: Number(row.codiArticle),
            ultimMissatge: '',
            estoc: Number(row.UnitatsServides) - Number(row.UnitatsVenudes) - Number(row.UnitatsEncarregades),
            unitatsVenudes: Number(row.UnitatsVenudes),
            unitatsServides: Number(row.UnitatsServides),
            unitatsEncarregades: Number(row.UnitatsEncarregades),
            ultimaActualitzacio: new Date().toISOString(),
          };
        }
      }
    }

    // --- GESTIÓ COMPROMISOS (Històric i Objectius) ---
    await actualitzaCompromisos(Llicencia, Empresa, avui, minutCalcul);
  } catch (error) {
    log('❌ Error a initVectorLlicencia:', error);
    throw error; // Llença l'error per a que es pugui gestionar més amunt
  }
}

/******************************* COMPROMISOS *********************************/
async function actualitzaCompromisos(Llicencia, Empresa, avui, minutCalcul) {
  const lastWeekSameDay = moment().subtract(7, 'days').format('YYYY-MM-DD');
  const lastWeekSameDayDia = moment().subtract(7, 'days').date();

  const taulaCompromisos = nomTaulaCompromiso(avui);
  const taulaVenutAvui = nomTaulaVenut(avui);
  const taulaVenutSetmanaPassada = nomTaulaVenut(new Date(lastWeekSameDay));

  async function taulesExisteixen() {
    const query = `
      USE ${Empresa};
      IF EXISTS (SELECT * FROM sys.tables WHERE name = '${taulaCompromisos}')
      AND EXISTS (SELECT * FROM sys.tables WHERE name = '${taulaVenutAvui}')
      AND EXISTS (SELECT * FROM sys.tables WHERE name = '${taulaVenutSetmanaPassada}')
      SELECT 1 AS Existeix;
    `;
    const result = await sql.query(query);

    if (result && result.recordset) {
      dbg('[Compromisos] Taules Existeixen', result);
      return result.recordset.length > 0;
    } else {
      dbg('[Compromisos] No existeix ' + taulaCompromisos + ' o ' + taulaVenutAvui + ' o ' + taulaVenutSetmanaPassada);
      return false;
    }
  }

  function buildQueryObjectius() {
    return `
      USE ${Empresa};
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
          FROM [${taulaCompromisos}]
          WHERE dia = '${moment(avui).format('YYYY-MM-DD')}' AND botiga = ${Llicencia}
        ) o
        JOIN [${taulaVenutAvui}] v ON v.plu = o.plu AND v.Botiga = ${Llicencia} AND DAY(v.data) = ${moment().date()}
        GROUP BY DATEDIFF(MINUTE, CAST(v.data AS DATE), v.data) / 30, objectiu, v.plu

        UNION ALL

        SELECT 'Past' AS T, v.plu, objectiu,
          DATEDIFF(MINUTE, CAST(v.data AS DATE), v.data) / 30 AS Min,
          SUM(v.quantitat) AS quantitat
        FROM (
          SELECT comentaris AS plu, objectiu
          FROM [${taulaCompromisos}]
          WHERE dia = '${moment(avui).format('YYYY-MM-DD')}' AND botiga = ${Llicencia}
        ) o
        JOIN [${taulaVenutSetmanaPassada}] v ON v.plu = o.plu AND v.Botiga = ${Llicencia} AND DAY(v.data) = ${lastWeekSameDayDia}
        GROUP BY DATEDIFF(MINUTE, CAST(v.data AS DATE), v.data) / 30, objectiu, v.plu
      ) a
      GROUP BY plu, objectiu, Min
      ORDER BY plu, objectiu, Min;
    `;
  }

  async function actualitzaEstoc(row, tipus) {
    const articleKey = row.codiArticle || row.articleCodi;
    const anterior = estocPerLlicencia[Llicencia][articleKey] || {};
    const historicAnterior = anterior.historic || [];

    const historicNou = historicAnterior.concat({
      Minut: row.Minut,
      SumaAvui: row.SumaAvui,
      SumaPast: row.SumaPast
    });

    const nou = {
      actiu: true,
      tipus,
      articleCodi: articleKey,
      ultimMissatge: '',
      historic: historicNou,
      minutCalcul,
    };

    if (tipus === 'IndicadorVenut') {
      nou.importVenut = (anterior.importVenut || 0) + parseFloat(row.SumaAvui);
      nou.importVenut7d = (anterior.importVenut7d || 0) + (row.Minut < minutCalcul ? parseFloat(row.SumaPast) : 0);
    } else {
      nou.unitatsVenudes = (anterior.unitatsVenudes || 0) + parseFloat(row.SumaAvui);
      nou.unitatsVenudes7d = (anterior.unitatsVenudes7d || 0) + (row.Minut < minutCalcul ? parseFloat(row.SumaPast) : 0);
      nou.objectiu = (anterior.objectiu || 0) + ((row.Minut < minutCalcul ? parseFloat(row.SumaPast) : 0) * (1 + parseFloat(row.Objectiu) / 100));
    }

    estocPerLlicencia[Llicencia][articleKey] = nou;
  }

  if (await taulesExisteixen()) {
    const query = buildQueryObjectius();
    const result = await sql.query(query);

    for (const row of result.recordset) {
      await actualitzaEstoc(row, 'Compromisos');
    }
    dbg('[Compromisos] Processats', result.recordset.length);
  }

  // Creació taula IndicadorsBotiga si no existeix
  const crearIndicadorsTaula = `
    USE ${Empresa};
    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'IndicadorsBotiga')
    BEGIN
      CREATE TABLE IndicadorsBotiga (
        ID uniqueidentifier DEFAULT newid() PRIMARY KEY,
        TmSt datetime DEFAULT getdate(),
        Botiga nvarchar(255),
        Tipus nvarchar(255),
        Actiu nvarchar(255),
        Param1 nvarchar(255),
        Param2 nvarchar(255),
        Param3 nvarchar(255),
        Param4 nvarchar(255),
        Param5 nvarchar(255)
      )
    END
  `;
  await sql.query(crearIndicadorsTaula);

  const tipus = 'IndicadorVenut';
  const queryIndicadors = `
    USE ${Empresa};
    IF EXISTS (SELECT * FROM sys.tables WHERE name = 'IndicadorsBotiga')
    BEGIN
      IF (SELECT COUNT(*) FROM IndicadorsBotiga WHERE Botiga = ${Llicencia} AND Actiu = '1' AND Tipus = '${tipus}') > 0
      BEGIN
        SELECT
          Min * 30 AS Minut,
          SUM(CASE WHEN T = 'Avui' THEN import ELSE 0 END) AS SumaAvui,
          SUM(CASE WHEN T = 'Past' THEN import ELSE 0 END) AS SumaPast
        FROM (
          SELECT 'Avui' AS T,
            DATEDIFF(MINUTE, CAST(v.data AS DATE), v.data) / 30 AS Min,
            SUM(v.import) AS import
          FROM [${taulaVenutAvui}] v
          WHERE v.Botiga = ${Llicencia} AND DAY(v.data) = ${moment().date()}
          GROUP BY DATEDIFF(MINUTE, CAST(v.data AS DATE), v.data) / 30

          UNION ALL

          SELECT 'Past' AS T,
            DATEDIFF(MINUTE, CAST(v.data AS DATE), v.data) / 30 AS Min,
            SUM(v.import) AS import
          FROM [${taulaVenutSetmanaPassada}] v
          WHERE v.Botiga = ${Llicencia} AND DAY(v.data) = ${lastWeekSameDayDia}
          GROUP BY DATEDIFF(MINUTE, CAST(v.data AS DATE), v.data) / 30
        ) a
        GROUP BY Min
        ORDER BY Min;
      END
    END
  `;
  const resultIndicadors = await sql.query(queryIndicadors);

  if (resultIndicadors && Array.isArray(resultIndicadors.recordset)) {
    for (const row of resultIndicadors.recordset) {
      await actualitzaEstoc(row, tipus);
    }
  }
}

/******************************* RECEPCIÓ MISSATGES **************************/
async function ObreCaixa(data) {
  dbg('🔓 ObreCaixa', data);
  try {
    await initVectorLlicencia(data.Llicencia, data.Empresa, data.CaixaDataInici);
  } catch (error) {
    log('❌ Error a ObreCaixa:', error);
    throw error;
  }
}

async function revisaIndicadors(data) {
  dbg('🧮 revisaIndicadors', data);
  if (!data || !Array.isArray(data.Articles)) {
    log('❌ Dades incorrectes o sense articles:', data);
    return;
  }

  try {
    await initVectorLlicencia(data.Llicencia, data.Empresa);
    const minutCalcul = new Date().getHours() * 60 + Math.floor(new Date().getMinutes());
    const tipus = data.tipus || 'Venta';
    let importTotalTicket = 0;

    data.Articles.forEach(article => {
      const articleCodi = Number(article.articleCodi || article.CodiArticle || 0);
      const quantitat = parseFloat(article.Quantitat || 0);
      const importArticle = parseFloat(article.import || 0);
      const control = estocPerLlicencia[data.Llicencia]?.[articleCodi];
      dbg('Article', articleCodi, 'Quantitat', quantitat, 'Import', importArticle, 'Control', control);

      if (!control) return;

      if (tipus === 'Venta') {
        importTotalTicket += importArticle;
        control.unitatsVenudes = parseFloat((control.unitatsVenudes + quantitat).toFixed(3));
      }
    });

    for (const control of Object.values(estocPerLlicencia[data.Llicencia])) {
      if (!control || typeof control !== 'object' || !control.tipus) continue;
      const missatge = generaMissatge(control, minutCalcul, importTotalTicket, data.Llicencia);

      dbg('MSG', control.articleCodi, missatge);

      if (control.ultimMissatge !== missatge) {
        control.ultimMissatge = missatge;
        const topic = `${process.env.MQTT_CLIENT_ID}/Estock/${data.Llicencia}`;
        dbg('MQTT →', topic, missatge);
        client.publish(topic, missatge);
        process.stdout.write('📨');
      }
    }
  } catch (error) {
    log('❌ Error a revisaIndicadors:', error);
  }
  dbg('⏹️ Fi revisaIndicadors');
}
/******************************* GENERACIÓ MISSATGES *************************/
function generaMissatge(control, minutCalcul, importTotalTicket, llicencia) {
  dbg('🔄 generaMissatge', control, minutCalcul, importTotalTicket, llicencia);
  const tipusControl = control.tipus;

  if (tipusControl === 'Encarrecs') {
    dbg('🔄 generaMissatge Encarrecs', control, minutCalcul, importTotalTicket, llicencia);
    return generaMissatgeEncarrecs(control, llicencia);
  } else if (tipusControl === 'Compromisos') {
    dbg('🔄 generaMissatge Compromisos', control, minutCalcul, importTotalTicket, llicencia);
    return generaMissatgeCompromisos(control, minutCalcul, llicencia);
  } else if (tipusControl === 'IndicadorVenut') {
    dbg('🔄 generaMissatge IndicadorVenut', control, minutCalcul, importTotalTicket, llicencia);
    return generaMissatgeIndicadorVenut(control, minutCalcul, importTotalTicket, llicencia);
  }

  return control.ultimMissatge;
}

function generaMissatgeEncarrecs(control, llicencia) {
  control.estoc = control.unitatsServides - control.unitatsVenudes - control.unitatsEncarregades;
  control.ultimaActualitzacio = new Date().toISOString();

  let emoji = '';
  if (control.estoc < 0) {
    emoji = '🤢';
  } else {
    const count = Math.min(5, Math.floor(control.estoc)); // 0‥5
    emoji = '🍒'.repeat(count);
  }

  const texte = `${emoji}${control.estoc} = ${control.unitatsServides} - ${control.unitatsVenudes} - ${control.unitatsEncarregades}`;
  const color = control.estoc < 0 ? 'Red' : control.estoc === 0 ? 'Green' : 'Black';
  const size = control.estoc < 0 ? 16 : 12;

  return JSON.stringify({
    Llicencia: llicencia,
    articleCodi: control.articleCodi,
    EstocActualitzat: texte,
    FontSize: size,
    FontColor: color,
  });
}

function generaMissatgeCompromisos(control, minutCalcul, llicencia) {
  control.historic.forEach(historic => {
    if (historic.Minut > control.minutCalcul && minutCalcul > control.minutCalcul) {
      control.unitatsVenudes7d += parseFloat(historic.SumaPast);
      control.minutCalcul = historic.Minut;
    }
  });

  const dif = Math.floor(control.unitatsVenudes - control.objectiu);
  let emoji = '💩';
  if (dif >= 1) emoji = '😃';
  else if (dif >= -5) emoji = '🍒'.repeat(Math.abs(dif));
  else if (dif < -5) emoji = '🤢';

  return JSON.stringify({
    Llicencia: llicencia,
    articleCodi: control.articleCodi,
    EstocActualitzat: emoji,
    FontSize: 20,
    FontColor: 'Black',
  });
}

function generaMissatgeIndicadorVenut(control, minutCalcul, importTotalTicket, llicencia) {
  control.articleCodi = 'IndicadorPos1';
  control.importVenut += importTotalTicket;

  control.historic.forEach(historic => {
    if (historic.Minut > control.minutCalcul && minutCalcul > control.minutCalcul) {
      control.importVenut7d += parseFloat(historic.SumaPast);
      control.importVenut += parseFloat(historic.SumaAvui);
      control.minutCalcul = historic.Minut;
    }
  });

  const dif = Math.floor((control.importVenut / control.importVenut7d) * 100) - 100;
  const importDiff = Math.round(control.importVenut - control.importVenut7d);
  const emojis = ['🤑', '😃', '😄', '😒', '😥', '😳', '😟', '💩', '😠', '😡', '🤬', '🤢', '🤢'];

  let color = 'Black', size = 17, index = 5;
  if (dif > 20) index = 0;
  else if (dif > 10) index = 1;
  else if (dif > 0) index = 2;
  else if (dif > -5) index = 3;
  else if (dif > -10) index = 4;
  else if (dif > -15) index = 5;
  else if (dif > -18) index = 6;
  else if (dif > -20) index = 7;
  else if (dif > -22) index = 8;
  else if (dif > -24) index = 9;
  else if (dif > -25) index = 10;
  else if (dif > -30) index = 11;
  else index = 12;

  if (dif < 0) {
    color = 'Red';
    size = 20;
  }

  return JSON.stringify({
    Llicencia: llicencia,
    articleCodi: control.articleCodi,
    EstocActualitzat: `${emojis[index]} ${importDiff}`,
    FontSize: size,
    FontColor: color,
  });
}


/******************************* TEST *************************/
if (process.argv.includes('--test')) {
  log('🧪 Mode test activat');
  test.describe('revisaIndicadors', () => {
    //  const data = JSON.parse('{"Llicencia":891,"Empresa":"Fac_Tena","Articles":[{"CodiArticle":"189","Quantitat":"1","import":"0.85"}]}')
    const data = JSON.parse('{"Llicencia":891,"Empresa":"Fac_Tena","Tipus":"ObreCaixa","Articles":[{"CodiArticle":"189","Quantitat":"1","import":"0.85"}]}');
    let clientMqttTest;

    test.before(async () => {
      await new Promise((resolve, reject) => {
        clientMqttTest = mqtt.connect({
          host: process.env.MQTT_HOST,
          port: process.env.MQTT_PORT,
          username: process.env.MQTT_USER,
          password: process.env.MQTT_PASSWORD,
          clientId: 'TestControl',
        });
        clientMqttTest.on('connect', () => {
          clientMqttTest.subscribe(`${process.env.MQTT_CLIENT_ID}/Estock/${data.Llicencia}`, (err) => {
            if (!err) {
              resolve();
            } else {
              reject(err);
            }
          });
        });
      });
    });

    test('Mirem si avisa per indicadors de venda', async () => {
      await revisaIndicadors(data);
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`No He rebut ${process.env.MQTT_CLIENT_ID}/Estock/${data.Llicencia}  10 segons`));
          resolve();
        }, 10000);
        clientMqttTest.on('message', (topic, message) => {
          if (topic === `${process.env.MQTT_CLIENT_ID}/Estock/${data.Llicencia}`) {
            clearTimeout(timeout);
            const missatge = JSON.parse(message.toString());
            assert.strictEqual(missatge.Llicencia, data.Llicencia);
            clientMqttTest.unsubscribe(`${process.env.MQTT_CLIENT_ID}/Estock/${data.Llicencia}`);
            resolve();
          }
        });
      });
    });

    test.after((done) => {
      clientMqttTest.end(false, () => {
        test.publish();
        process.exitCode = 0;
        done();
      });
    });
  });
} else {
  // Mantenir el programa en execució
  log('🚀 Programa arrencat');
  process.stdin.resume();
}
