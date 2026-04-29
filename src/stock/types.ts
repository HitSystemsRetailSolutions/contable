export interface ControlData {
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
  historic?: Array<{ Minut: number; SumaAvui: number; SumaPast: number; ClientsAvui?: number; ClientsPast?: number }>;
  minutCalcul?: number;
  objectiu?: number;
  unitatsVenudes7d?: number;
  importVenut?: number;
  importVenut7d?: number;
  clientsVenut?: number;
  clientsVenut7d?: number;
}
