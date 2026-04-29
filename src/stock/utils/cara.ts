import { get } from 'node-emoji';

/**
 * Funció pctCara(n1, n2) per replicar el càlcul d'emojis comparatius (caretes)
 * que fa el bot a la comanda V.
 * 
 * @param n1 vendes de la setmana passada (referència)
 * @param n2 vendes d'avui (valor actual)
 * @returns emoji corresponent o string buit si p és NaN
 */
export function pctCara(n1: number, n2: number): string {
  let cara = '';
  const p = (1 - n1 / n2) * 100;

  if (isNaN(p)) return '';

  // L'algoritme NO usa else if: cada if sobreescriu cara segons l'ordre original.
  if (p < 0) {
    cara = get('worried') || '';
  } else {
    cara = get('smiley') || '';
  }

  if (p < -10) cara = get('disappointed_relieved') || '';
  if (p < -15) cara = get('rage') || '';
  if (p > 10) cara = get('stuck_out_tongue_winking_eye') || '';
  if (p > 20) cara = get('heart_eyes') || '';

  return cara;
}
