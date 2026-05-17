const measurementId = import.meta.env.VITE_GA_MEASUREMENT_ID;

type GtagCommand = 'config' | 'event' | 'js';

type GtagParams = Record<string, string | number | boolean | undefined>;

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (command: GtagCommand, target: string | Date, params?: GtagParams) => void;
  }
}

let hasInitialized = false;
let lastTrackedPage = '';

export const initAnalytics = () => {
  if (!measurementId || hasInitialized || typeof window === 'undefined') {
    return;
  }

  hasInitialized = true;
  window.dataLayer = window.dataLayer ?? [];
  window.gtag = function gtag(...args) {
    window.dataLayer?.push(args);
  };

  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${measurementId}`;
  document.head.appendChild(script);

  window.gtag('js', new Date());
  window.gtag('config', measurementId, { send_page_view: false });
};

export const trackPageView = (path = `${window.location.pathname}${window.location.search}`) => {
  if (!measurementId || typeof window === 'undefined' || !window.gtag || path === lastTrackedPage) {
    return;
  }

  lastTrackedPage = path;
  window.gtag('event', 'page_view', {
    page_location: window.location.href,
    page_path: path,
    page_title: document.title,
  });
};

export const trackEvent = (eventName: string, params: GtagParams = {}) => {
  if (!measurementId || typeof window === 'undefined' || !window.gtag) {
    return;
  }

  window.gtag('event', eventName, params);
};
