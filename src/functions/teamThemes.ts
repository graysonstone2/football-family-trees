import themeData from '../teamThemes.json';

export type TeamTheme = {
  school: string;
  primary: string;
  secondary: string;
};

type ThemeData = {
  themes: TeamTheme[];
};

type Rgb = {
  b: number;
  g: number;
  r: number;
};

export const DEFAULT_THEME: TeamTheme = {
  school: 'Football Family Trees',
  primary: '#12343b',
  secondary: '#e0b25d',
};

export const TEAM_THEMES = [DEFAULT_THEME, ...(themeData as ThemeData).themes];

const clamp = (value: number) => Math.max(0, Math.min(255, Math.round(value)));

const normalizeHex = (hex: string) => {
  const clean = hex.replace('#', '').trim();
  return clean.length === 3
    ? clean
        .split('')
        .map((digit) => `${digit}${digit}`)
        .join('')
    : clean.padEnd(6, '0').slice(0, 6);
};

const hexToRgb = (hex: string): Rgb => {
  const clean = normalizeHex(hex);
  return {
    b: parseInt(clean.slice(4, 6), 16),
    g: parseInt(clean.slice(2, 4), 16),
    r: parseInt(clean.slice(0, 2), 16),
  };
};

const rgbToHex = ({ b, g, r }: Rgb) =>
  `#${[r, g, b].map((value) => clamp(value).toString(16).padStart(2, '0')).join('')}`;

const mix = (hex: string, target: string, amount: number) => {
  const color = hexToRgb(hex);
  const targetColor = hexToRgb(target);

  return rgbToHex({
    b: color.b + (targetColor.b - color.b) * amount,
    g: color.g + (targetColor.g - color.g) * amount,
    r: color.r + (targetColor.r - color.r) * amount,
  });
};

const relativeLuminance = (hex: string) => {
  const { b, g, r } = hexToRgb(hex);
  const channels = [r, g, b].map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });

  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
};

const readableText = (background: string) => (relativeLuminance(background) > 0.48 ? '#111827' : '#ffffff');

const shouldUseSecondaryAsAccent = (secondary: string) => {
  const { b, g, r } = hexToRgb(secondary);
  const brightness = (r * 299 + g * 587 + b * 114) / 1000;
  const spread = Math.max(r, g, b) - Math.min(r, g, b);

  return brightness < 235 && spread > 18;
};

export const getThemeVars = (theme: TeamTheme) => {
  const primary = theme.primary;
  const secondary = shouldUseSecondaryAsAccent(theme.secondary) ? theme.secondary : DEFAULT_THEME.secondary;
  const primaryText = readableText(primary);
  const accentText = readableText(secondary);

  return {
    '--theme-accent': secondary,
    '--theme-accent-soft': mix(secondary, '#ffffff', 0.78),
    '--theme-accent-text': accentText,
    '--theme-border': mix(primary, '#ffffff', 0.78),
    '--theme-hero-muted': mix(primaryText, primary, primaryText === '#ffffff' ? 0.18 : 0.4),
    '--theme-ink': '#1d2528',
    '--theme-line': mix(primary, secondary, 0.28),
    '--theme-muted': '#58676a',
    '--theme-page': mix(primary, '#ffffff', 0.94),
    '--theme-primary': primary,
    '--theme-primary-hover': mix(primary, '#000000', 0.18),
    '--theme-primary-soft': mix(primary, '#ffffff', 0.9),
    '--theme-primary-text': primaryText,
    '--theme-surface': '#ffffff',
    '--theme-surface-soft': mix(secondary, '#ffffff', 0.9),
  };
};
