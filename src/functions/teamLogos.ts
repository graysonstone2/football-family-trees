import logoManifest from '../../fbs_logos/manifest.json';

type LogoManifest = {
  logos: Array<{
    school: string;
    file: string;
  }>;
};

const logoModules = import.meta.glob('../../fbs_logos/*.png', {
  eager: true,
  import: 'default',
  query: '?url',
}) as Record<string, string>;

const normalizeSchool = (school: string) =>
  school
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/\(([^)]+)\)/g, ' $1 ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const manifest = logoManifest as LogoManifest;

const logoBySchool = new Map<string, string>();
const logoBySlug = new Map<string, string>();

manifest.logos.forEach(({ file, school }) => {
  const logoUrl = logoModules[`../../${file}`];

  if (!logoUrl) {
    return;
  }

  logoBySchool.set(school, logoUrl);
  logoBySlug.set(normalizeSchool(school), logoUrl);
});

Object.entries(logoModules).forEach(([path, logoUrl]) => {
  const filename = path.split('/').pop()?.replace(/\.png$/, '');

  if (filename) {
    logoBySlug.set(filename, logoUrl);
  }
});

export const getTeamLogo = (school?: string) => {
  if (!school) {
    return null;
  }

  return logoBySchool.get(school) ?? logoBySlug.get(normalizeSchool(school)) ?? null;
};
