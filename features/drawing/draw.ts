import type { Map } from "maplibre-gl";
import { TerraDraw, TerraDrawPolygonMode } from "terra-draw";
import { TerraDrawMapLibreGLAdapter } from "terra-draw-maplibre-gl-adapter";

type CreateDrawOptions = {
  map: Map;
  onReady: () => void;
  onFinish: () => void;
};

export function createDraw({ map, onReady, onFinish }: CreateDrawOptions) {
  const draw = new TerraDraw({
    adapter: new TerraDrawMapLibreGLAdapter({ map, minPixelDragDistance: 8 }),
    modes: [new TerraDrawPolygonMode({ projection: "globe" })],
  });

  const finishDrawing = () => {
    draw.setMode("static");
    onFinish();
  };

  draw.on("ready", onReady);
  draw.on("finish", finishDrawing);
  draw.start();

  return {
    draw,
    startPolygonDrawing() {
      draw.setMode("polygon");
    },
    isDrawingPolygon() {
      return draw.getMode() === "polygon";
    },
    reset() {
      if (draw.getMode() !== "static") draw.setMode("static");
      draw.clear();
    },
    stop() {
      draw.off("finish", finishDrawing);
      draw.stop();
    },
  };
}

export type DrawController = ReturnType<typeof createDraw>;
