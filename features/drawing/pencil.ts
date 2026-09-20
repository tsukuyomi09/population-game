import type { Feature, FeatureCollection, LineString, Point, Position } from "geojson";
import type { GeoJSONSource, Map, MapMouseEvent } from "maplibre-gl";

type ScreenPoint = { x: number; y: number };

type StrokePoint = {
  coordinate: Position;
  screen: ScreenPoint;
};

type StrokeStatus = "normal" | "close" | "invalid";

type CreatePencilOptions = {
  map: Map;
  canStart: (point: ScreenPoint) => boolean;
  completePolygon: (ring: Position[], screenRing: ScreenPoint[]) => boolean;
};

const SOURCE_ID = "worldrawing-pencil";
const LINE_LAYER_ID = "worldrawing-pencil-line";
const ENDPOINT_LAYER_ID = "worldrawing-pencil-endpoint";
const CLOSE_HINT_DISTANCE = 16;
const CLOSE_DISTANCE = 8;
const RESUME_DISTANCE = 18;
const MIN_STROKE_LENGTH = 70;
const MIN_LOOP_LENGTH = 55;
const RECENT_SEGMENTS_TO_IGNORE = 5;
const COORDINATE_PRECISION = 9;
const POLYGON_SIMPLIFY_TOLERANCE = 2;

function coordinate(lng: number, lat: number): Position {
  const factor = 10 ** COORDINATE_PRECISION;
  return [Math.round(lng * factor) / factor, Math.round(lat * factor) / factor];
}

function distance(a: ScreenPoint, b: ScreenPoint) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function cross(a: ScreenPoint, b: ScreenPoint) {
  return a.x * b.y - a.y * b.x;
}

function subtract(a: ScreenPoint, b: ScreenPoint): ScreenPoint {
  return { x: a.x - b.x, y: a.y - b.y };
}

function segmentIntersection(
  a: ScreenPoint,
  b: ScreenPoint,
  c: ScreenPoint,
  d: ScreenPoint,
) {
  const movement = subtract(b, a);
  const segment = subtract(d, c);
  const denominator = cross(movement, segment);

  if (Math.abs(denominator) < 0.000001) return null;

  const offset = subtract(c, a);
  const movementRatio = cross(offset, segment) / denominator;
  const segmentRatio = cross(offset, movement) / denominator;

  if (
    movementRatio < 0 ||
    movementRatio > 1 ||
    segmentRatio < 0 ||
    segmentRatio > 1
  ) {
    return null;
  }

  return {
    point: {
      x: a.x + movement.x * movementRatio,
      y: a.y + movement.y * movementRatio,
    },
    movementRatio,
  };
}

function closestPointOnSegment(
  point: ScreenPoint,
  start: ScreenPoint,
  end: ScreenPoint,
) {
  const segment = subtract(end, start);
  const lengthSquared = segment.x * segment.x + segment.y * segment.y;

  if (lengthSquared === 0) {
    return { point: start, distance: distance(point, start) };
  }

  const offset = subtract(point, start);
  const ratio = Math.max(
    0,
    Math.min(1, (offset.x * segment.x + offset.y * segment.y) / lengthSquared),
  );
  const closest = {
    x: start.x + segment.x * ratio,
    y: start.y + segment.y * ratio,
  };

  return { point: closest, distance: distance(point, closest) };
}

function squaredDistanceToSegment(
  point: ScreenPoint,
  start: ScreenPoint,
  end: ScreenPoint,
) {
  const closest = closestPointOnSegment(point, start, end).point;
  const x = point.x - closest.x;
  const y = point.y - closest.y;
  return x * x + y * y;
}

function simplifyLoop(ring: Position[], screenRing: ScreenPoint[]) {
  const screens = screenRing.slice(0, -1);
  const coordinates = ring.slice(0, -1);
  const keep = new Set([0, screens.length - 1]);
  const toleranceSquared = POLYGON_SIMPLIFY_TOLERANCE ** 2;

  const simplifySection = (startIndex: number, endIndex: number) => {
    let furthestIndex = -1;
    let furthestDistance = toleranceSquared;

    for (let index = startIndex + 1; index < endIndex; index += 1) {
      const distanceSquared = squaredDistanceToSegment(
        screens[index],
        screens[startIndex],
        screens[endIndex],
      );

      if (distanceSquared > furthestDistance) {
        furthestIndex = index;
        furthestDistance = distanceSquared;
      }
    }

    if (furthestIndex === -1) return;
    keep.add(furthestIndex);
    simplifySection(startIndex, furthestIndex);
    simplifySection(furthestIndex, endIndex);
  };

  simplifySection(0, screens.length - 1);
  const indices = [...keep].sort((left, right) => left - right);
  const simplifiedRing = indices.map((index) => coordinates[index]);
  const simplifiedScreenRing = indices.map((index) => screens[index]);

  simplifiedRing.push(simplifiedRing[0]);
  simplifiedScreenRing.push(simplifiedScreenRing[0]);

  return { ring: simplifiedRing, screenRing: simplifiedScreenRing };
}

function pathLength(points: ScreenPoint[], startIndex = 0) {
  let length = 0;

  for (let index = startIndex + 1; index < points.length; index += 1) {
    length += distance(points[index - 1], points[index]);
  }

  return length;
}

function signedArea(ring: ScreenPoint[]) {
  let area = 0;

  for (let index = 0; index < ring.length - 1; index += 1) {
    area +=
      ring[index].x * ring[index + 1].y -
      ring[index + 1].x * ring[index].y;
  }

  return area / 2;
}

function getClosureCandidate(map: Map, points: StrokePoint[]) {
  if (points.length < RECENT_SEGMENTS_TO_IGNORE + 4) return null;

  const screens = points.map((point) => point.screen);
  if (pathLength(screens) < MIN_STROKE_LENGTH) return null;

  const currentStart = screens.at(-2)!;
  const currentEnd = screens.at(-1)!;
  const lastEarlierSegment = points.length - RECENT_SEGMENTS_TO_IGNORE - 2;
  const intersections: Array<{
    segmentIndex: number;
    point: ScreenPoint;
    movementRatio: number;
  }> = [];
  let nearest:
    | { segmentIndex: number; point: ScreenPoint; distance: number }
    | undefined;

  for (let index = 0; index <= lastEarlierSegment; index += 1) {
    const start = screens[index];
    const end = screens[index + 1];
    const intersection = segmentIntersection(currentStart, currentEnd, start, end);

    if (intersection) {
      intersections.push({ segmentIndex: index, ...intersection });
      continue;
    }

    const candidate = closestPointOnSegment(currentEnd, start, end);
    if (!nearest || candidate.distance < nearest.distance) {
      nearest = { segmentIndex: index, ...candidate };
    }
  }

  const intersection = intersections.sort(
    (left, right) => left.movementRatio - right.movementRatio,
  )[0];
  const closure = intersection
    ? {
        segmentIndex: intersection.segmentIndex,
        point: intersection.point,
        distance: 0,
        shouldClose: true,
      }
    : nearest && nearest.distance <= CLOSE_HINT_DISTANCE
      ? {
          ...nearest,
          shouldClose: nearest.distance <= CLOSE_DISTANCE,
        }
      : null;

  if (!closure) return null;

  const loopLength =
    distance(closure.point, screens[closure.segmentIndex + 1]) +
    pathLength(screens, closure.segmentIndex + 1) +
    distance(currentEnd, closure.point);

  if (loopLength < MIN_LOOP_LENGTH) return null;

  const closureLngLat = map.unproject([closure.point.x, closure.point.y]);
  const closureCoordinate = coordinate(closureLngLat.lng, closureLngLat.lat);
  const loopPoints = points.slice(closure.segmentIndex + 1, -1);
  const unsimplifiedRing = [
    closureCoordinate,
    ...loopPoints.map((point) => point.coordinate),
    closureCoordinate,
  ];
  const unsimplifiedScreenRing = [
    closure.point,
    ...loopPoints.map((point) => point.screen),
    closure.point,
  ];
  const { ring, screenRing } = simplifyLoop(
    unsimplifiedRing,
    unsimplifiedScreenRing,
  );

  return {
    ring,
    screenRing,
    shouldClose: closure.shouldClose,
    hasUsableArea: Math.abs(signedArea(screenRing)) >= 80,
  };
}

function createStrokeData(
  points: StrokePoint[],
  status: StrokeStatus,
): FeatureCollection<LineString | Point> {
  const features: Array<Feature<LineString | Point>> = [];

  if (points.length >= 2) {
    features.push({
      type: "Feature",
      properties: { kind: "line", status },
      geometry: {
        type: "LineString",
        coordinates: points.map((point) => point.coordinate),
      },
    });
  }

  const endpoint = points.at(-1);
  if (endpoint) {
    features.push({
      type: "Feature",
      properties: { kind: "endpoint", status },
      geometry: { type: "Point", coordinates: endpoint.coordinate },
    });
  }

  return { type: "FeatureCollection", features };
}

export function pointInScreenPolygon(point: ScreenPoint, ring: ScreenPoint[]) {
  let inside = false;

  for (let current = 0, previous = ring.length - 1; current < ring.length; previous = current++) {
    const a = ring[current];
    const b = ring[previous];
    const crosses =
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;

    if (crosses) inside = !inside;
  }

  return inside;
}

export function screenPolygonsOverlap(
  candidate: ScreenPoint[],
  existing: ScreenPoint[],
) {
  for (let left = 0; left < candidate.length - 1; left += 1) {
    for (let right = 0; right < existing.length - 1; right += 1) {
      if (
        segmentIntersection(
          candidate[left],
          candidate[left + 1],
          existing[right],
          existing[right + 1],
        )
      ) {
        return true;
      }
    }
  }

  return (
    pointInScreenPolygon(candidate[0], existing) ||
    pointInScreenPolygon(existing[0], candidate)
  );
}

export function createPencil({
  map,
  canStart,
  completePolygon,
}: CreatePencilOptions) {
  let points: StrokePoint[] = [];
  let status: StrokeStatus = "normal";
  let enabled = false;
  let drawing = false;
  let restoreDragPan = false;
  let restoreDragRotate = false;

  map.addSource(SOURCE_ID, {
    type: "geojson",
    data: createStrokeData(points, status),
  });
  map.addLayer({
    id: LINE_LAYER_ID,
    type: "line",
    source: SOURCE_ID,
    filter: ["==", ["get", "kind"], "line"],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": [
        "match",
        ["get", "status"],
        "invalid",
        "#ef4444",
        "close",
        "#22c55e",
        "#0f172a",
      ],
      "line-width": 4,
      "line-opacity": 0.95,
    },
  });
  map.addLayer({
    id: ENDPOINT_LAYER_ID,
    type: "circle",
    source: SOURCE_ID,
    filter: ["==", ["get", "kind"], "endpoint"],
    paint: {
      "circle-radius": [
        "match",
        ["get", "status"],
        "close",
        8,
        "invalid",
        8,
        6,
      ],
      "circle-color": [
        "match",
        ["get", "status"],
        "invalid",
        "#ef4444",
        "close",
        "#22c55e",
        "#0f172a",
      ],
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 2,
    },
  });

  const render = () => {
    const source = map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
    source?.setData(createStrokeData(points, status));
  };

  const reprojectPoints = () => {
    points = points.map((point) => {
      const projected = map.project({
        lng: point.coordinate[0],
        lat: point.coordinate[1],
      });

      return {
        coordinate: point.coordinate,
        screen: { x: projected.x, y: projected.y },
      };
    });
  };

  const setCursor = (cursor: string) => {
    map.getCanvas().style.cursor = cursor;
  };

  const restoreNavigation = () => {
    if (restoreDragPan) map.dragPan.enable();
    if (restoreDragRotate) map.dragRotate.enable();
    restoreDragPan = false;
    restoreDragRotate = false;
  };

  const disable = () => {
    enabled = false;
    drawing = false;
    restoreNavigation();
    setCursor("");
  };

  const clear = () => {
    points = [];
    status = "normal";
    drawing = false;
    render();
  };

  const appendPoint = (event: MapMouseEvent) => {
    const nextPoint: StrokePoint = {
      coordinate: coordinate(event.lngLat.lng, event.lngLat.lat),
      screen: { x: event.point.x, y: event.point.y },
    };
    const previous = points.at(-1);

    if (previous && distance(previous.screen, nextPoint.screen) < 0.75) return;

    points.push(nextPoint);
    const closure = getClosureCandidate(map, points);

    if (!closure) {
      status = "normal";
      render();
      return;
    }

    if (!closure.shouldClose) {
      status = "close";
      render();
      return;
    }

    if (
      !closure.hasUsableArea ||
      !completePolygon(closure.ring, closure.screenRing)
    ) {
      status = "invalid";
      drawing = false;
      render();
      return;
    }

    clear();
    disable();
  };

  const handleMouseDown = (event: MapMouseEvent) => {
    if (!enabled || event.originalEvent.button !== 0) return;

    event.preventDefault();
    const point = { x: event.point.x, y: event.point.y };
    const endpoint = points.at(-1);

    if (!canStart(point)) {
      setCursor("not-allowed");
      return;
    }

    if (endpoint) {
      const projectedEndpoint = map.project({
        lng: endpoint.coordinate[0],
        lat: endpoint.coordinate[1],
      });

      if (distance(point, projectedEndpoint) > RESUME_DISTANCE) {
        setCursor("not-allowed");
        return;
      }
    }

    drawing = true;
    status = "normal";
    appendPoint(event);
  };

  const handleMouseMove = (event: MapMouseEvent) => {
    if (!enabled) return;

    if (drawing && (event.originalEvent.buttons & 1) === 1) {
      appendPoint(event);
      return;
    }

    const endpoint = points.at(-1);
    const point = { x: event.point.x, y: event.point.y };
    const canDrawHere = canStart(point);
    const canResume = endpoint
      ? canDrawHere &&
        distance(
          point,
          map.project({
            lng: endpoint.coordinate[0],
            lat: endpoint.coordinate[1],
          }),
        ) <= RESUME_DISTANCE
      : canDrawHere;

    setCursor(canResume ? "crosshair" : "not-allowed");
  };

  const pause = () => {
    drawing = false;
  };

  map.on("mousedown", handleMouseDown);
  map.on("mousemove", handleMouseMove);
  map.on("mouseup", pause);
  window.addEventListener("mouseup", pause);

  return {
    enable() {
      if (enabled) return;

      reprojectPoints();
      enabled = true;
      restoreDragPan = map.dragPan.isEnabled();
      restoreDragRotate = map.dragRotate.isEnabled();
      map.dragPan.disable();
      map.dragRotate.disable();
      setCursor("crosshair");
    },
    disable,
    cancel() {
      clear();
      if (enabled) setCursor("crosshair");
    },
    clear,
    hasStroke() {
      return points.length > 0;
    },
    pause,
    isEnabled() {
      return enabled;
    },
    setProjection() {
      reprojectPoints();
      status = "normal";
      render();
    },
    stop() {
      disable();
      map.off("mousedown", handleMouseDown);
      map.off("mousemove", handleMouseMove);
      map.off("mouseup", pause);
      window.removeEventListener("mouseup", pause);

      if (map.getLayer(ENDPOINT_LAYER_ID)) map.removeLayer(ENDPOINT_LAYER_ID);
      if (map.getLayer(LINE_LAYER_ID)) map.removeLayer(LINE_LAYER_ID);
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
    },
  };
}

export type PencilController = ReturnType<typeof createPencil>;
