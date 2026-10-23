// Where the speaker is, for the care network (market.ts).
//
// An Alexa device knows its location; the simulated Alexa+ sends it with every MCP
// request as `x-petcheck-location: <lat>,<lng>` (+ an optional URI-encoded
// `x-petcheck-location-label`), from the browser's geolocation or a preset. Without it,
// PetCheck uses the household's address (HOME_LAT / HOME_LNG / HOME_LABEL).

import { AsyncLocalStorage } from "node:async_hooks";

export interface Place {
  lat: number;
  lng: number;
  /** An area name, never a street address: requests show this to every sitter. */
  label: string;
  source: "device" | "home";
}

export const HOME: Place = {
  lat: Number(process.env.HOME_LAT ?? 42.2808),
  lng: Number(process.env.HOME_LNG ?? -83.743),
  label: process.env.HOME_LABEL ?? "Ann Arbor, MI",
  source: "home",
};

const scoped = new AsyncLocalStorage<Place>();

/** The speaker's device location for this request, or the household's address. */
export function deviceLocation(): Place {
  return scoped.getStore() ?? HOME;
}

/** Parse the location headers; anything malformed is ignored (the household address is used). */
export function parseLocation(coords: string | undefined, label: string | undefined): Place | undefined {
  const m = coords?.match(/^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/);
  if (!m) return undefined;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return undefined;
  let name = "this device's location";
  try {
    if (label) name = decodeURIComponent(label).slice(0, 60);
  } catch {
    // keep the default name
  }
  return { lat, lng, label: name, source: "device" };
}

/** Run fn (and everything it awaits) with this device location. */
export function withDeviceLocation<T>(place: Place | undefined, fn: () => T): T {
  return place ? scoped.run(place, fn) : fn();
}

/** Great-circle distance in miles. */
export function milesBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(h));
}
