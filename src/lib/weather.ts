export interface GeoHit { lat: number; lng: number; label: string }

export async function geocode(city: string): Promise<GeoHit | null> {
  const r = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`,
  );
  const j = await r.json();
  const hit = j?.results?.[0];
  if (!hit) return null;
  return {
    lat: hit.latitude,
    lng: hit.longitude,
    label: `${hit.name}${hit.admin1 ? ", " + hit.admin1 : ""}${hit.country ? ", " + hit.country : ""}`,
  };
}

export async function currentWeather(city: string) {
  const g = await geocode(city);
  if (!g) return null;
  const r = await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${g.lat}&longitude=${g.lng}` +
      `&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code` +
      `&hourly=temperature_2m,precipitation_probability,weather_code&forecast_hours=24`,
  );
  const j = await r.json();
  return { location: g.label, current: j.current, hourly: j.hourly };
}