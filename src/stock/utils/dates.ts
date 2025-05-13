export function formatData(
    d: Date,
    format: 'YY-MM-DD' | 'YYYY-MM' | 'YYYY_MM' = 'YY-MM-DD',
  ) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    switch (format) {
      case 'YY-MM-DD':
        return `${yyyy.toString().slice(-2)}-${mm}-${dd}`;
      case 'YYYY-MM':
        return `${yyyy}-${mm}`;
      case 'YYYY_MM':
        return `${yyyy}_${mm}`;
    }
  }
  
  export const nomTaulaServit = (d: Date) => `Servit-${formatData(d)}`;
  export const nomTaulaVenut = (d: Date) => `V_Venut_${formatData(d, 'YYYY-MM')}`;
  export const nomTaulaEncarregs = (d: Date) => `V_Encarre_${formatData(d, 'YYYY-MM')}`;
  export const nomTaulaCompromiso = (d: Date) => `Compromiso_${formatData(d, 'YYYY_MM')}`;
  
  