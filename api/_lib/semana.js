// Hora de Venezuela (America/Caracas = UTC-4 todo el año, sin horario de verano).
// Inicio del día (00:00), de la semana (lunes 00:00) y de la semana siguiente, en ISO (UTC).
// Lo usan api/ranking.js (mejores clientes) y api/minijuego.js (ranking semanal del minijuego).
const DESFASE_VE_MS = 4 * 60 * 60 * 1000;
const DIA_MS = 24 * 60 * 60 * 1000;

export function iniciosVE(ahora = Date.now()) {
  const dia = Math.floor((ahora - DESFASE_VE_MS) / DIA_MS) * DIA_MS;
  const lunes = dia - ((new Date(dia).getUTCDay() + 6) % 7) * DIA_MS; // lunes = 0
  return {
    dia: new Date(dia + DESFASE_VE_MS).toISOString(),
    semana: new Date(lunes + DESFASE_VE_MS).toISOString(),
    proximaSemana: new Date(lunes + 7 * DIA_MS + DESFASE_VE_MS).toISOString(),
  };
}
