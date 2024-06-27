import { test, describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import mqtt from "mqtt";
import sql from "mssql";
import moment from "moment";
import 'dotenv/config';

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

//********************************************************************************/ MQTT
// Connexió al servidor MQTT
const client = mqtt.connect(mqttOptions);

client.on("connect", () => {
  console.log("Connectat al servidor MQTT", process.env.MQTT_HOST);
  // Subscripció al topic desitjat
  client.subscribe(process.env.MQTT_CLIENT_ID + "/Conta/#", (err) => {
    if (!err) {
      console.log(
        "Subscrit al topic: ",
        process.env.MQTT_CLIENT_ID + "/Conta/#"
      );
    } else {
      console.log("Error al subscriure al topic:", err);
    }
  });
});

// Manejador per a missatges rebuts
client.on("message", (topic, missatge) => {
  let data
  try {
    data=JSON.parse(missatge);
  } catch (parseError) {
    console.error("Error al analitzar el missatge com a JSON:", parseError);
    return; // Si hi ha un error, aturem l'execució aquí i retornem
  }
  let tipus = "Venta";
  if (data.tipus) tipus = data.tipus; 
  switch (tipus) {
    case "ObreCaixa":
      process.stdout.write('🏷️')  
      ObreCaixa(data);
      break;
    case "Venta":
        process.stdout.write('🛒')  
        revisaIndicadors(data);
        break;
    case "Encarrec","Encarrec":
      process.stdout.write('⏰')  
      revisaIndicadors(data);
      break;
    default:
      console.log("Tipus de missatge desconegut:", tipus);
  }
});

//******************************************************************************************************************* */ Funcions auxiliars
function nomTaulaServit(d) {
  // [Servit-24-02-10]
  const year = d.getFullYear().toString().slice(-2);
  const month = (d.getMonth() + 1).toString().padStart(2, "0"); // El mes, assegurant-se que té dos dígits.
  const day = d.getDate().toString().padStart(2, "0"); // El dia, assegurant-se que té dos dígits.

  return `Servit-${year}-${month}-${day}`;
}

function nomTaulaVenut(d) {
  //[V_Venut_2024-02]
  const year = d.getFullYear().toString();
  const month = (d.getMonth() + 1).toString().padStart(2, "0");
  return `V_Venut_${year}-${month}`;
}
function nomTaulaEncarregs(d) {
  //[v_encarre_2024-02]
  const year = d.getFullYear().toString();
  const month = (d.getMonth() + 1).toString().padStart(2, "0");
  return `V_Encarre_${year}-${month}`;
}

function nomTaulaCompromiso(d) {
  //[v_encarre_2024-02]
  const year = d.getFullYear().toString();
  const month = (d.getMonth() + 1).toString().padStart(2, "0");
  return `Compromiso_${year}_${month}`;
}

async function initVectorLlicencia(Llicencia, Empresa, dataInici = null) {
    const avui = new Date();
    const dataIniciDefecte = new Date(avui.getFullYear(), avui.getMonth(), avui.getDate(), 0, 0, 0); // Si dataInici no està definida, utilitza "avui a les 00:00"
    const dataIniciUsada = dataInici ? new Date(dataInici) : dataIniciDefecte;
    try {
      if (
        dataInici == null &&
        estocPerLlicencia[Llicencia] &&
        estocPerLlicencia[Llicencia]["LastUpdate"] &&
        new Date(estocPerLlicencia[Llicencia]["LastUpdate"]).toDateString() === avui.toDateString()) return;
        console.log('🔄')  
        // si sql no esta conectat la conectem i esperem a que estigui conectat
      if (!sql.connected) await sql.connect(dbConfig);
      let sqlSt = "";
      let LlicenciaA = Llicencia;
//      if (process.env.NODE_ENV === "Dsv") LlicenciaA = 819; // T91 per proves
      const anyActual = avui.getFullYear();
      const mesActual = avui.getMonth(); // Mes actual (0-indexat)
      const diesDelMes = new Date(anyActual, mesActual + 1, 0).getDate(); // Correcte: obté el darrer dia del mes
      const minutCalcul = avui.getHours() * 60 + Math.floor(avui.getMinutes()); // Calcula el minut actual (0-47)
      estocPerLlicencia[Llicencia] = {};
      estocPerLlicencia[Llicencia] = estocPerLlicencia[Llicencia] || {};
      estocPerLlicencia[Llicencia]["LastUpdate"] = new Date().toISOString(); // Estableix o actualitza la data d'última actualització

      if (Empresa == "Fac_Camps") {
        for (let dia = 1; dia <= diesDelMes; dia++) {
          let d = new Date(avui.getFullYear(), avui.getMonth(), dia);
          sqlSt += ` union select codiArticle as Article,sum(Quantitatservida) as s ,0 as v,0 as e from  [${nomTaulaServit(d)}] where client = ${Llicencia} and quantitatservida>0 group by codiArticle `
        };
        sqlSt = `use ${Empresa} 
                 select Article as codiArticle,isnull(sum(s),0) as UnitatsServides,isnull(Sum(v),0) as UnitatsVenudes, isnull(Sum(e),0) As unitatsEncarregades  from ( 
                    select plu as Article ,0 as s ,sum(quantitat) as v , 0 as  e  from  [${nomTaulaVenut(avui)}]  where botiga = ${Llicencia} group by plu
                    union select Article as Article ,0 as s , 0 aS V , Sum(quantitat) AS e  from  [${nomTaulaEncarregs(avui)}] where botiga = ${Llicencia} and estat = 0 Group by article 
                    ` + sqlSt
      sqlSt += ` ) t group by Article having isnull(Sum(e),0) > 0 `;
//console.log(sqlSt);
      let result = await sql.query(sqlSt);
      result.recordset.forEach(row => {
        if(row.unitatsEncarregades>0)        
          estocPerLlicencia[Llicencia][row.codiArticle] = {
            actiu: true,
            articleCodi: row.codiArticle,
            ultimMissatge: "",  
            estoc: (row.UnitatsServides - row.UnitatsVenudes - row.unitatsEncarregades),
            tipus: 'Encarrecs',
            unitatsVenudes: parseFloat(row.UnitatsVenudes),
            unitatsServides: parseFloat(row.UnitatsServides),
            unitatsEncarregades: parseFloat(row.unitatsEncarregades),
            ultimaActualitzacio: new Date().toISOString()
          };
      });
    }
    const lastWeekSameDay = moment().subtract(7, 'days').format('YYYY-MM-DD'); // Mateix dia de la setmana, setmana passada
    let lastWeekSameDayDia = moment().subtract(7, 'days').date();
    let historicArrayNew = [];
    let objectiuNew = 0;
    let unitatsVenudesNew = 0;
    let unitatsVenudes7dNew = 0;

    sqlSt=`use ${Empresa} 
        IF EXISTS (SELECT * FROM sys.tables WHERE name = '${nomTaulaCompromiso(avui)}') And EXISTS (SELECT * FROM sys.tables WHERE name = '${nomTaulaVenut(avui)}') And EXISTS (SELECT * FROM sys.tables WHERE name = '${nomTaulaVenut(new Date(lastWeekSameDay))}')     
        BEGIN   
          SELECT 
          plu as codiArticle,
          objectiu as Objectiu,
          Min*30 as Minut,
          SUM(CASE WHEN T = 'Avui' THEN quantitat ELSE 0 END) AS SumaAvui,
          SUM(CASE WHEN T = 'Past' THEN quantitat ELSE 0 END) AS SumaPast
          FROM 
          (
          -- Subconsulta per les dades "Avui"
          SELECT 
              'Avui' AS T,
              v.plu,
              objectiu,
              (DATEDIFF(MINUTE, CAST(v.data AS DATE), v.data) / 30) AS Min,
              SUM(v.quantitat) AS quantitat
          FROM 
              (SELECT comentaris AS plu, objectiu 
              FROM [${nomTaulaCompromiso(avui)}] 
              WHERE dia = '${moment(avui).format(
                "YYYY-MM-DD"
              )}' AND botiga =  ${Llicencia}) o
          JOIN 
          [${nomTaulaVenut(
            avui
          )}] v ON v.plu = o.plu AND v.Botiga =  ${LlicenciaA} AND DAY(v.data) = ${moment().date()}
          GROUP BY 
              (DATEDIFF(MINUTE, CAST(v.data AS DATE), v.data) / 30),
              objectiu,
              v.plu
            UNION ALL
            -- Subconsulta per les dades "Passat"
          SELECT 
              'Past' AS T,
              v.plu,
              objectiu,
              (DATEDIFF(MINUTE, CAST(v.data AS DATE), v.data) / 30) AS Min,
              SUM(v.quantitat) AS quantitat
          FROM 
              (SELECT comentaris AS plu, objectiu 
              FROM [${nomTaulaCompromiso(avui)}] 
              WHERE dia = '${moment(avui).format(
                "YYYY-MM-DD"
              )}' AND botiga =  ${Llicencia}) o
          JOIN 
          [${nomTaulaVenut(
            new Date(lastWeekSameDay)
          )}] v ON v.plu = o.plu AND v.Botiga =  ${LlicenciaA}  AND DAY(v.data) = ${lastWeekSameDayDia} 
          GROUP BY 
              (DATEDIFF(MINUTE, CAST(v.data AS DATE), v.data) / 30),
              objectiu,
              v.plu
          ) a 
          GROUP BY 
          plu,
          objectiu,
          Min 
          ORDER BY 
          plu,
          objectiu,
          Min 
        END `;
//console.log(sqlSt);          
    let result2 = await sql.query(sqlSt);
    if (result2.recordset && result2.recordset.length > 0) 
    result2.recordset.forEach(async row => {
        historicArrayNew = [];
        unitatsVenudesNew = parseFloat(row.SumaAvui);
        unitatsVenudes7dNew = row.Minut < minutCalcul ? parseFloat(row.SumaPast) : 0;
        objectiuNew = unitatsVenudes7dNew * (1 + parseFloat(row.Objectiu) / 100);
  sqlSt=`use ${Empresa} 
      IF EXISTS (SELECT * FROM sys.tables WHERE name = '${nomTaulaCompromiso(avui)}') And EXISTS (SELECT * FROM sys.tables WHERE name = '${nomTaulaVenut(avui)}') And EXISTS (SELECT * FROM sys.tables WHERE name = '${nomTaulaVenut(new Date(lastWeekSameDay))}')     
      BEGIN   
         SELECT 
         plu as articleCodi,
         objectiu as Objectiu,
         Min*30 as Minut,
         SUM(CASE WHEN T = 'Avui' THEN quantitat ELSE 0 END) AS SumaAvui,
         SUM(CASE WHEN T = 'Past' THEN quantitat ELSE 0 END) AS SumaPast
         FROM 
         (
         -- Subconsulta per les dades "Avui"
         SELECT 
             'Avui' AS T,
             v.plu,
             objectiu,
             (DATEDIFF(MINUTE, CAST(v.data AS DATE), v.data) / 30) AS Min,
             SUM(v.quantitat) AS quantitat
         FROM 
             (SELECT comentaris AS plu, objectiu 
             FROM [${nomTaulaCompromiso(avui)}] 
             WHERE dia = '${moment(avui).format(
               "YYYY-MM-DD"
             )}' AND botiga =  ${Llicencia}) o
         JOIN 
         [${nomTaulaVenut(
           avui
         )}] v ON v.plu = o.plu AND v.Botiga =  ${LlicenciaA} AND DAY(v.data) = ${moment().date()}
         GROUP BY 
             (DATEDIFF(MINUTE, CAST(v.data AS DATE), v.data) / 30),
             objectiu,
             v.plu
          UNION ALL
          -- Subconsulta per les dades "Passat"
         SELECT 
             'Past' AS T,
             v.plu,
             objectiu,
             (DATEDIFF(MINUTE, CAST(v.data AS DATE), v.data) / 30) AS Min,
             SUM(v.quantitat) AS quantitat
         FROM 
             (SELECT comentaris AS plu, objectiu 
             FROM [${nomTaulaCompromiso(avui)}] 
             WHERE dia = '${moment(avui).format(
               "YYYY-MM-DD"
             )}' AND botiga =  ${Llicencia}) o
         JOIN 
         [${nomTaulaVenut(
           new Date(lastWeekSameDay)
         )}] v ON v.plu = o.plu AND v.Botiga =  ${LlicenciaA}  AND DAY(v.data) = ${lastWeekSameDayDia} 
         GROUP BY 
             (DATEDIFF(MINUTE, CAST(v.data AS DATE), v.data) / 30),
             objectiu,
             v.plu
         ) a 
         GROUP BY 
         plu,
         objectiu,
         Min 
         ORDER BY 
         plu,
         objectiu,
        Min 
      END `;
//console.log(sqlSt);          
  result2 = await sql.query(sqlSt);
  result2.recordset.forEach(row => {
      historicArrayNew = [];
      unitatsVenudesNew = parseFloat(row.SumaAvui);
      unitatsVenudes7dNew = row.Minut < minutCalcul ? parseFloat(row.SumaPast) : 0;
      objectiuNew = unitatsVenudes7dNew * (1 + parseFloat(row.Objectiu) / 100);

        if (estocPerLlicencia[Llicencia][row.codiArticle]) {
          if(estocPerLlicencia[Llicencia][row.codiArticle].historic) historicArrayNew = estocPerLlicencia[Llicencia][row.codiArticle].historic;
          if(estocPerLlicencia[Llicencia][row.codiArticle].unitatsVenudes) unitatsVenudesNew = estocPerLlicencia[Llicencia][row.codiArticle].unitatsVenudes + unitatsVenudesNew;
          if(estocPerLlicencia[Llicencia][row.codiArticle].unitatsVenudes7d) unitatsVenudes7dNew = estocPerLlicencia[Llicencia][row.codiArticle].unitatsVenudes7d + unitatsVenudes7dNew;
          if(estocPerLlicencia[Llicencia][row.codiArticle].objectiu) objectiuNew = estocPerLlicencia[Llicencia][row.codiArticle].objectiu + objectiuNew;
        }
      if (estocPerLlicencia[Llicencia][row.articleCodi]) {
        if(estocPerLlicencia[Llicencia][row.articleCodi].historic) historicArrayNew = estocPerLlicencia[Llicencia][row.articleCodi].historic;
        if(estocPerLlicencia[Llicencia][row.articleCodi].unitatsVenudes) unitatsVenudesNew = estocPerLlicencia[Llicencia][row.articleCodi].unitatsVenudes + unitatsVenudesNew;
        if(estocPerLlicencia[Llicencia][row.articleCodi].unitatsVenudes7d) unitatsVenudes7dNew = estocPerLlicencia[Llicencia][row.articleCodi].unitatsVenudes7d + unitatsVenudes7dNew;
        if(estocPerLlicencia[Llicencia][row.articleCodi].objectiu) objectiuNew = estocPerLlicencia[Llicencia][row.articleCodi].objectiu + objectiuNew;
      }

        estocPerLlicencia[Llicencia][row.codiArticle] = {
          actiu: true,
          tipus: "Compromisos",
          articleCodi: row.codiArticle,
          ultimMissatge: "",
          historic: historicArrayNew.concat({
            Minut: row.Minut,
            SumaAvui: row.SumaAvui,
            SumaPast: row.SumaPast,
          }),
          unitatsVenudes: parseFloat(unitatsVenudesNew),
          unitatsVenudes7d: parseFloat(unitatsVenudes7dNew),
          objectiu: objectiuNew,
          minutCalcul: minutCalcul,
        };
      });
      estocPerLlicencia[Llicencia][row.articleCodi] = {
        actiu: true,
        tipus: "Compromisos",
        articleCodi: row.articleCodi,
        ultimMissatge: "",
        historic: historicArrayNew.concat({
          Minut: row.Minut,
          SumaAvui: row.SumaAvui,
          SumaPast: row.SumaPast,
        }),
        unitatsVenudes: parseFloat(unitatsVenudesNew),
        unitatsVenudes7d: parseFloat(unitatsVenudes7dNew),
        objectiu: objectiuNew,
        minutCalcul: minutCalcul,
      };
    });

      sqlSt = `use ${Empresa} 
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
          END `
    let tipus = 'IndicadorVenut';       
    sqlSt=`use ${Empresa} 
          IF EXISTS (SELECT * FROM sys.tables WHERE name = 'IndicadorsBotiga')      
          BEGIN   
          if (Select count(*) from IndicadorsBotiga Where Botiga = ${Llicencia} and Actiu = '1' and Tipus = '${tipus}') > 0
          begin
          select 
                Min*30 as Minut,
                SUM(CASE WHEN T = 'Avui' THEN import ELSE 0 END) AS SumaAvui,
                SUM(CASE WHEN T = 'Past' THEN import ELSE 0 END) AS SumaPast
                FROM 
                (
                -- Subconsulta per les dades "Avui"
                SELECT 
                    'Avui' AS T,
                    (DATEDIFF(MINUTE, CAST(v.data AS DATE), v.data) / 30) AS Min,
                    SUM(v.import) AS import
                FROM 
                [${nomTaulaVenut(
                  avui
                )}] v where v.Botiga =  ${LlicenciaA} AND DAY(v.data) = ${moment().date()}
                GROUP BY 
                    (DATEDIFF(MINUTE, CAST(v.data AS DATE), v.data) / 30)
                  UNION ALL
                  -- Subconsulta per les dades "Passat"
                SELECT 
                    'Past' AS T,
                    (DATEDIFF(MINUTE, CAST(v.data AS DATE), v.data) / 30) AS Min,
                    SUM(v.import) AS import
                FROM 
                [${nomTaulaVenut(
                  new Date(lastWeekSameDay)
                )}] v where v.Botiga =  ${LlicenciaA}  AND DAY(v.data) = ${lastWeekSameDayDia}
                GROUP BY 
                    (DATEDIFF(MINUTE, CAST(v.data AS DATE), v.data) / 30)
                ) a 
                GROUP BY 
                Min 
                ORDER BY 
                Min
            end    
          END`;
  //console.log(sqlSt);          
      result2 = await sql.query(sqlSt);
      if (result2 && result2.recordset) {
        result2.recordset.forEach((row) => {
          historicArrayNew = [];
          let importVenutNew = parseFloat(row.SumaAvui);
          let importVenut7dNew = row.Minut < minutCalcul ? parseFloat(row.SumaPast) : 0;

          if (estocPerLlicencia[Llicencia][tipus]) {
            historicArrayNew    = estocPerLlicencia[Llicencia][tipus].historic;
            importVenutNew = estocPerLlicencia[Llicencia][tipus].importVenut + parseFloat(importVenutNew);
            importVenut7dNew    = estocPerLlicencia[Llicencia][tipus].importVenut7d + parseFloat(importVenut7dNew);
          }

          estocPerLlicencia[Llicencia][tipus] = {
            actiu: true,
            tipus: tipus,
            articleCodi: tipus,
            ultimMissatge: "",
            historic: historicArrayNew.concat({
              Minut: row.Minut,
              SumaAvui: row.SumaAvui,
              SumaPast: row.SumaPast,
            }),
            importVenut: parseFloat(importVenutNew),
            importVenut7d: parseFloat(importVenut7dNew),
            minutCalcul: minutCalcul,
          };
        });
      }
    } catch (error) {
      console.error(error);
      // Gestiona l'error o llança'l de nou si és necessari.
      throw error; // Llançar l'error farà que la promesa sigui rebutjada.
    }
}
// Quan es rep un missatge MQTT
async function ObreCaixa(data) {
  await initVectorLlicencia(data.Llicencia, data.Empresa, data.CaixaDataInici);
}
/********************************************** */
// Quan es rep un missatge MQTT
async function revisaIndicadors(data) {
// Comprovar si 'data' té la propietat 'Articles' i que és una array
  let missatge = ""
  let ImportTotalTicket = 0;
  if (data && data.Articles && Array.isArray(data.Articles)) {
    try {
      await initVectorLlicencia(data.Llicencia, data.Empresa);
      const minutCalcul = new Date().getHours() * 60 + Math.floor(new Date().getMinutes()); // Calcula el minut actual (0-47)
      let tipus = "Venta";
      if (data.tipus) tipus = data.tipus; 
      data.Articles.forEach((article) => {  // actualitzem les dades a l estructura d articles controlats
        let articleCodi=0
        if(article.articleCodi) articleCodi = article.articleCodi
        if(article.CodiArticle) articleCodi = article.CodiArticle
        switch (tipus) {
          case "Venta":
            ImportTotalTicket+= parseFloat(article.import);
            if (estocPerLlicencia[data.Llicencia][articleCodi]) estocPerLlicencia[data.Llicencia][articleCodi].unitatsVenudes = parseFloat((parseFloat(article.Quantitat) + parseFloat(estocPerLlicencia[data.Llicencia][articleCodi].unitatsVenudes)).toFixed(3))
          break;
          case "Encarreg":
            if (estocPerLlicencia[data.Llicencia][articleCodi]) estocPerLlicencia[data.Llicencia][articleCodi].unitatsEncarregades = parseFloat((parseFloat(article.Quantitat) + parseFloat(estocPerLlicencia[data.Llicencia][articleCodi].unitatsEncarregades)).toFixed(3))
          break;
        }
      });

      Object.values(estocPerLlicencia[data.Llicencia]).forEach((controlat) => {  // Revisem els indicadors 
        if (process.env.NODE_ENV === "Dsv") console.log(controlat);
        missatge = controlat.ultimMissatge; // Creem el missatge
        if (controlat.tipus === "Encarrecs") {    // Si hi ha encarregs 
          controlat.estoc =
            parseFloat(controlat.unitatsServides) -
            parseFloat(controlat.unitatsVenudes) -
            parseFloat(controlat.unitatsEncarregades);
          controlat.ultimaActualitzacio = new Date().toISOString();
          let texte = controlat.estoc + ' = ' +  parseFloat(controlat.unitatsServides) + ' - ' + parseFloat(controlat.unitatsVenudes) + ' - ' + parseFloat(controlat.unitatsEncarregades);
          let size = 12
          let color = "Black"
          if (controlat.estoc <  0){
            color = "Red"
            size = 17
            texte = '🤢' + texte
          }
          if (controlat.estoc == 0) {
            texte = '🎯' + texte
            color = "Green"
          }
          if (controlat.estoc == 1) texte = '🍒' + texte
          if (controlat.estoc == 2) texte = '🍒🍒' + texte
          if (controlat.estoc == 3) texte = '🍒🍒🍒' + texte
          if (controlat.estoc == 4) texte = '🍒🍒🍒🍒' + texte
          if (controlat.estoc == 5) texte = '🍒🍒🍒🍒🍒' + texte

          missatge = JSON.stringify({
            Llicencia: data.Llicencia,
            articleCodi: controlat.articleCodi,
            EstocActualitzat: texte,
            FontSize: size,
            FontColor: color,
          })
//console.log(missatge)          
        } else if (controlat.tipus === "Compromisos") {
          controlat.historic.forEach((historic) => {
            if (historic.Minut > controlat.minutCalcul && minutCalcul > controlat.minutCalcul) {
              controlat.unitatsVenudes7d = parseFloat(controlat.unitatsVenudes7d) + parseFloat(historic.SumaPast);
              controlat.minutCalcul = historic.Minut;
            }
          });

          missatge = parseFloat(controlat.unitatsVenudes) > parseFloat(controlat.objectiu) ? "😄": "💩";
          let dif = Math.floor(controlat.unitatsVenudes - controlat.objectiu);
          let carasInc = ["", "😃", "🍒", "🤢"];
          if (dif >= 2) missatge = carasInc[0];
          else if (dif === 1)  missatge = carasInc[1]; // Bé, supera l'objectiu per 1 unitat
          else if (dif === 0)  missatge = carasInc[1];
          else if (dif === -1) missatge = carasInc[2];
          else if (dif === -2) missatge = carasInc[2] + carasInc[2];
          else if (dif === -3) missatge = carasInc[2] + carasInc[2] + carasInc[2];
          else if (dif === -4) missatge = carasInc[2] + carasInc[2] + carasInc[2] + carasInc[2];
          else if (dif === -5) missatge = carasInc[2] + carasInc[2] + carasInc[2] + carasInc[2] + carasInc[2];
          else if (dif === -6) missatge = carasInc[2] + carasInc[2] + carasInc[2] + carasInc[2] + carasInc[2] + carasInc[2];
          else if (dif <= -6) missatge = carasInc[3];
          else if (dif >= 1) missatge = "";

          missatge = JSON.stringify({Llicencia: data.Llicencia,
            articleCodi: controlat.articleCodi,
                                     EstocActualitzat: missatge,
                                     FontSize: 20,
                                     FontColor: "Black",
                                   })
        } else if (controlat.tipus === "IndicadorVenut") {
          controlat.articleCodi = 'IndicadorPos1';
          if(!ImportTotalTicket) ImportTotalTicket=0;
          controlat.importVenut = parseFloat(controlat.importVenut) + parseFloat(ImportTotalTicket); 
          controlat.historic.forEach((historic) => {
            if (historic.Minut > controlat.minutCalcul && minutCalcul > controlat.minutCalcul) {
              controlat.importVenut7d = parseFloat(controlat.importVenut7d) + parseFloat(historic.SumaPast);
              controlat.importVenut = parseFloat(controlat.importVenut) + parseFloat(historic.SumaAvui);
              controlat.minutCalcul = historic.Minut;
            }
          });

          if (process.env.NODE_ENV === "Dsv") console.log('Venut ', controlat.importVenut, 'Venut 7d ', controlat.importVenut7d);
          let dif = Math.floor(controlat.importVenut/controlat.importVenut7d * 100 )  -100 ;  // Calculem la diferència en percentatge
          let carasInc = ["🤑","😃","😄","😒","😥","😳","😟","💩","😠","😡","🤬","🤢","🤢"];
          missatge = Math.round(controlat.importVenut) + ' ' + carasInc[5];
          if      (dif >20  )  missatge = Math.round(controlat.importVenut) + ' ' + carasInc[0];
          else if (dif >10  )  missatge= Math.round(controlat.importVenut) + ' ' + carasInc[1];
          else if (dif >0   )  missatge= Math.round(controlat.importVenut) + ' ' + carasInc[2];
          else if (dif > -5 )  missatge= Math.round(controlat.importVenut) + ' ' + carasInc[3];
          else if (dif > -10)  missatge= Math.round(controlat.importVenut) + ' ' + carasInc[4];
          else if (dif > -15)  missatge= Math.round(controlat.importVenut) + ' ' + carasInc[5];
          else if (dif > -18)  missatge= Math.round(controlat.importVenut) + ' ' + carasInc[6];
          else if (dif > -20)  missatge= Math.round(controlat.importVenut) + ' ' + carasInc[7];
          else if (dif > -22)  missatge= Math.round(controlat.importVenut) + ' ' + carasInc[8];
          else if (dif > -24)  missatge= Math.round(controlat.importVenut) + ' ' + carasInc[9];
          else if (dif > -25)  missatge= Math.round(controlat.importVenut) + ' ' + carasInc[10];
          else if (dif > -30)  missatge= Math.round(controlat.importVenut) + ' ' + carasInc[11];
          else if (dif > -50)  missatge= Math.round(controlat.importVenut) + ' ' + carasInc[12];
          missatge = JSON.stringify({
            Llicencia: data.Llicencia,
            articleCodi: controlat.articleCodi,
            EstocActualitzat: missatge,
            FontSize: 17,
            FontColor: "Black",
          })
        }
    if (controlat.ultimMissatge !== missatge) {
      controlat.ultimMissatge = missatge;
      client.publish(`${process.env.MQTT_CLIENT_ID}/Estock/${data.Llicencia}`,controlat.ultimMissatge);
      //console.log(controlat.ultimMissatge)
      process.stdout.write('📨')            
    }        
      });
    } catch (error) {
      console.error("Error handling stock: ", error);
    }
  }
}


// Test code
if (process.argv.includes('--test')) {
  test.describe('revisaIndicadors', () => {
  //  const data = JSON.parse('{"Llicencia":891,"Empresa":"Fac_Tena","Articles":[{"CodiArticle":"189","Quantitat":"1","import":"0.85"}]}') 
    const data = JSON.parse('{"Llicencia":891,"Empresa":"Fac_Tena","Tipus":"ObreCaixa","Articles":[{"CodiArticle":"189","Quantitat":"1","import":"0.85"}]}') 
    let clientMqttTest  

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
        test.publish()
        process.exitCode = 0;
        done();
      });
    });

  });
}else{// Mantenir el programa en execució
  process.stdin.resume();
}

