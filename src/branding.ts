// Брендинг тура: логотип в углу плеера. Фиксированный и всегда включён — ни
// тумблера, ни замены в настройках нет: это логотип ZYXED Engineering
// (см. brandingDefault.ts). Раньше логотип/подпись можно было задать самому и
// они лежали в localStorage (zyxed360:branding) — теперь это значение
// игнорируется, чтобы брендинг в этой версии был одинаковым у всех туров.
import { DEFAULT_LOGO } from "./brandingDefault";

export interface Branding {
  logo?: string; // data: URI
  text?: string;
}

const BRANDING: Branding = { logo: DEFAULT_LOGO };

export function getBranding(): Branding {
  return BRANDING;
}

export function useBranding(): Branding {
  return BRANDING;
}
