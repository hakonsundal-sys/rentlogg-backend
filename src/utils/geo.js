// Distance between two coordinates, in metres. Lived as a private function at the bottom of
// routes/sites.js until the timeregistrering module needed the exact same "is this phone actually
// at the site" check on both stamp-in and stamp-out — three call sites is where a copy stops being
// cheaper than an import, and a second copy drifting from the first would mean two different
// answers to the same question on the same visit.
export function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// The one rule for "did this stamping happen at the site": inside the site's own gps_radius_meters.
// Returns 0 when either side has no coordinates — same convention the QR check-in already used,
// where an unverified stamping is informational, never a blocker (a basement with no signal is a
// normal working day, not a fraud attempt).
export function isWithinSiteRadius(site, latitude, longitude) {
  if (latitude == null || longitude == null) return 0;
  if (site.latitude == null || site.longitude == null) return 0;
  return haversineMeters(latitude, longitude, site.latitude, site.longitude) <= site.gps_radius_meters ? 1 : 0;
}
