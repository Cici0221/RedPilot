#!/usr/bin/env python3
"""Render a locally linked product CAD model without copying the source.

Dependencies: cadquery (for STEP), vtk, numpy. Installed packages are used as-is.
Geometry is tessellated once into a content-addressed VTK cache. No product
parts, labels, holes or optical effects are added to the imported model.
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import sys
import time

WIDTH, HEIGHT = 1200, 1600
CACHE_VERSION = 3
MESH_EXTENSIONS = {".stl", ".obj", ".ply", ".vtp"}
MODEL_EXTENSIONS = MESH_EXTENSIONS | {".step", ".stp"}


class RenderError(Exception):
    pass


def digest_file(filename: Path) -> str:
    digest = hashlib.sha256()
    with filename.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


@contextlib.contextmanager
def native_stdout_to_stderr():
    """Keep native OpenCASCADE progress output away from the result JSON."""
    sys.stdout.flush()
    saved = os.dup(1)
    try:
        os.dup2(2, 1)
        yield
    finally:
        sys.stdout.flush()
        os.dup2(saved, 1)
        os.close(saved)


def probe() -> dict:
    modules = {name: importlib.util.find_spec(name) is not None for name in ("cadquery", "vtk", "numpy")}
    return {"available": all(modules.values()), "engine": "cadquery-vtk", "dependencies": modules}


def mesh_reader(filename, vtk):
    readers = {".stl": vtk.vtkSTLReader, ".obj": vtk.vtkOBJReader, ".ply": vtk.vtkPLYReader, ".vtp": vtk.vtkXMLPolyDataReader}
    reader = readers[filename.suffix.lower()]()
    reader.SetFileName(str(filename))
    reader.Update()
    if not reader.GetOutput().GetNumberOfPoints():
        raise RenderError("模型中没有可渲染的网格")
    polydata = vtk.vtkPolyData()
    polydata.DeepCopy(reader.GetOutput())
    return polydata


def create_geometry_cache(model, cache, source_sha, vtk):
    import cadquery as cq
    manifest_file = cache / "manifest.json"
    if manifest_file.exists():
        try:
            manifest = json.loads(manifest_file.read_text())
            if manifest.get("cacheVersion") == CACHE_VERSION and all((cache / part["file"]).is_file() for part in manifest["parts"]):
                return manifest, True
        except (ValueError, KeyError, OSError):
            pass
    parts = []
    if model.suffix.lower() in MESH_EXTENSIONS:
        shapes = [(mesh_reader(model, vtk), model.stem, (0.78, 0.80, 0.83, 1.0), False)]
    else:
        with native_stdout_to_stderr():
            try:
                assembly = cq.Assembly.load(str(model), "STEP")
                loaded = list(assembly)
            except ValueError as error:
                if "does not contain an assembly" not in str(error):
                    raise
                loaded = []
            if loaded:
                shapes = [(shape.moved(location), name, color.toTuple() if color else (0.78, 0.80, 0.83, 1.0), True)
                          for shape, name, location, color in loaded if shape is not None]
            else:
                solid = cq.importers.importStep(str(model)).val()
                shapes = [(solid, model.stem, (0.78, 0.80, 0.83, 1.0), True)]
    for index, (shape, name, rgba, cad) in enumerate(shapes):
        print(f"Meshing {index + 1}/{len(shapes)}: {name}", file=sys.stderr)
        if cad:
            # Absolute deflection avoids pathological detail expansion on the
            # many microscopic PCB edges. Native export avoids Python's per-
            # vertex OCP binding traversal and keeps all real source geometry.
            temp_stl = cache / f"part-{index:03d}.tmp.stl"
            with native_stdout_to_stderr():
                exterior = any(token in name.lower() for token in ("shell", "lha40", "lightpipe"))
                written = shape.exportStl(str(temp_stl), tolerance=0.008 if exterior else 0.035, angularTolerance=0.06 if exterior else 0.16,
                                          ascii=False, relative=False, parallel=True)
            if not written:
                raise RenderError("无法将 CAD 部件转换为网格")
            polydata = mesh_reader(temp_stl, vtk)
            temp_stl.unlink()
        else:
            polydata = shape
        if polydata is None or not polydata.GetNumberOfCells():
            continue
        filename = f"part-{index:03d}.vtp"
        writer = vtk.vtkXMLPolyDataWriter()
        writer.SetFileName(str(cache / filename))
        writer.SetInputData(polydata)
        writer.SetDataModeToAppended()
        writer.SetCompressorTypeToZLib()
        if writer.Write() != 1:
            raise RenderError("无法保存模型网格缓存")
        parts.append({"file": filename, "name": name, "rgba": list(rgba), "triangles": polydata.GetNumberOfCells()})
    if not parts:
        raise RenderError("模型中没有可渲染的实体")
    manifest = {"cacheVersion": CACHE_VERSION, "sourceSha256": source_sha, "parts": parts, "createdAt": time.time()}
    temp = cache / "manifest.json.tmp"
    temp.write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    temp.replace(manifest_file)
    return manifest, False


def render_geometry(cache, manifest, output, preset, vtk):
    renderer = vtk.vtkRenderer()
    renderer.SetBackground(0.974, 0.978, 0.985)
    renderer.AutomaticLightCreationOff()
    if hasattr(renderer, "UseFXAAOn"):
        renderer.UseFXAAOn()
    bounds = [math.inf, -math.inf, math.inf, -math.inf, math.inf, -math.inf]
    for part in manifest["parts"]:
        reader = vtk.vtkXMLPolyDataReader()
        reader.SetFileName(str(cache / part["file"]))
        reader.Update()
        polydata = reader.GetOutput()
        b = polydata.GetBounds()
        for index in (0, 2, 4):
            bounds[index] = min(bounds[index], b[index])
            bounds[index + 1] = max(bounds[index + 1], b[index + 1])
        normals = vtk.vtkPolyDataNormals()
        normals.SetInputData(polydata)
        normals.SetFeatureAngle(55)
        normals.ConsistencyOn()
        normals.AutoOrientNormalsOn()
        mapper = vtk.vtkPolyDataMapper()
        mapper.SetInputConnection(normals.GetOutputPort())
        mapper.ScalarVisibilityOff()
        actor = vtk.vtkActor()
        actor.SetMapper(mapper)
        color = part["rgba"]
        # The supplied product render shows a neutral white top shell. The CAD
        # preview uses a blue-grey distinction color; keep geometry unchanged.
        if "top_shell" in part["name"].lower():
            color = (0.94, 0.945, 0.95, 1.0)
        prop = actor.GetProperty()
        # CAD source RGBA is used as an opaque material reference. Optical
        # transmittance is unknown, so no unverified glowing/translucent LED.
        prop.SetColor(*color[:3])
        prop.SetInterpolationToPhong()
        prop.SetAmbient(0.35)
        prop.SetDiffuse(0.55)
        prop.SetSpecular(0.36)
        prop.SetSpecularPower(55)
        if "bottom_shell" in part["name"].lower():
            prop.SetAmbient(0.58)
        renderer.AddActor(actor)
    cx, cy, cz = ((bounds[2 * i] + bounds[2 * i + 1]) / 2 for i in range(3))
    dx, dy, dz = (bounds[2 * i + 1] - bounds[2 * i] for i in range(3))
    size = max(dx, dy, dz)
    if not math.isfinite(size) or size <= 0:
        raise RenderError("模型尺寸无效")
    floor_z = bounds[4] - size * 0.0008
    plane = vtk.vtkPlaneSource()
    plane.SetOrigin(cx - size * 3, cy - size * 3, floor_z)
    plane.SetPoint1(cx + size * 3, cy - size * 3, floor_z)
    plane.SetPoint2(cx - size * 3, cy + size * 3, floor_z)
    floor_mapper = vtk.vtkPolyDataMapper()
    floor_mapper.SetInputConnection(plane.GetOutputPort())
    floor = vtk.vtkActor()
    floor.SetMapper(floor_mapper)
    floor.GetProperty().SetColor(0.974, 0.978, 0.985)
    floor.GetProperty().SetAmbient(0.40)
    floor.GetProperty().SetDiffuse(0.50)
    renderer.AddActor(floor)
    key = vtk.vtkLight()
    key.SetLightTypeToSceneLight()
    key.SetPosition(cx - 1.8 * size, cy - 2.5 * size, floor_z + 4.5 * size)
    key.SetFocalPoint(cx, cy, cz)
    key.SetIntensity(0.85)
    key.SetPositional(True)
    key.SetConeAngle(80)
    key.SetShadowAttenuation(0.35)
    renderer.AddLight(key)
    # The fill light follows the camera and does not create a second shadow.
    # A single geometry-derived ground shadow avoids ghosted multi-light edges.
    fill = vtk.vtkLight()
    fill.SetLightTypeToHeadlight()
    fill.SetIntensity(0.70)
    renderer.AddLight(fill)
    # Actual geometry casts the shadow. This is VTK's shadow-map pass, not a
    # painted ellipse or a fabricated product component.
    shadows = vtk.vtkShadowMapPass()
    shadows.GetShadowMapBakerPass().SetResolution(4096)
    collection = vtk.vtkRenderPassCollection()
    collection.AddItem(shadows.GetShadowMapBakerPass())
    collection.AddItem(shadows)
    sequence = vtk.vtkSequencePass()
    sequence.SetPasses(collection)
    camera_pass = vtk.vtkCameraPass()
    camera_pass.SetDelegatePass(sequence)
    renderer.SetPass(camera_pass)
    camera = renderer.GetActiveCamera()
    views = {"studio": (1.35, -1.7, 1.45), "front": (0, -2.2, 0.82), "angle": (-1.55, -1.9, 1.15)}
    vx, vy, vz = views[preset]
    camera.SetPosition(cx + vx * size, cy + vy * size, cz + vz * size)
    camera.SetFocalPoint(cx, cy, cz)
    camera.SetViewUp(0, 0, 1)
    camera.ParallelProjectionOn()
    # Fit exactly the product, excluding the studio floor, at portrait ratio.
    direction = [camera.GetDirectionOfProjection()[i] for i in range(3)]
    right = [direction[1], -direction[0], 0]
    norm = math.sqrt(sum(v * v for v in right)) or 1
    right = [v / norm for v in right]
    up = [right[1] * direction[2], -right[0] * direction[2], right[0] * direction[1] - right[1] * direction[0]]
    norm = math.sqrt(sum(v * v for v in up)) or 1
    up = [v / norm for v in up]
    corners = [(x - cx, y - cy, z - cz) for x in bounds[:2] for y in bounds[2:4] for z in bounds[4:6]]
    span_x = max(sum(p[i] * right[i] for i in range(3)) for p in corners) - min(sum(p[i] * right[i] for i in range(3)) for p in corners)
    span_y = max(sum(p[i] * up[i] for i in range(3)) for p in corners) - min(sum(p[i] * up[i] for i in range(3)) for p in corners)
    camera.SetParallelScale(max(span_y / 2, span_x / (2 * WIDTH / HEIGHT)) * 1.22)
    window = vtk.vtkRenderWindow()
    window.SetOffScreenRendering(1)
    window.SetSize(WIDTH, HEIGHT)
    window.SetMultiSamples(0)
    window.AddRenderer(renderer)
    renderer.ResetCameraClippingRange()
    window.Render()
    capture = vtk.vtkWindowToImageFilter()
    capture.SetInput(window)
    capture.SetInputBufferTypeToRGB()
    capture.ReadFrontBufferOff()
    capture.Update()
    temp = output.with_name(output.name + ".tmp.png")
    writer = vtk.vtkPNGWriter()
    writer.SetFileName(str(temp))
    writer.SetInputConnection(capture.GetOutputPort())
    writer.Write()
    window.Finalize()
    if not temp.is_file() or temp.stat().st_size < 1024:
        raise RenderError("渲染器没有生成有效的产品图片")
    temp.replace(output)
    return {"bounds": bounds, "dimensions": [dx, dy, dz], "materialBasis": "source CAD colors; neutral white top shell follows supplied product render", "parts": len(manifest["parts"]), "triangles": sum(p["triangles"] for p in manifest["parts"])}


def main():
    parser = argparse.ArgumentParser(description="从本地 CAD/网格模型渲染产品图，源文件保持原地只读")
    parser.add_argument("--model", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--preset", choices=("studio", "front", "angle"), default="studio")
    parser.add_argument("--cache-dir", type=Path)
    parser.add_argument("--probe", action="store_true")
    args = parser.parse_args()
    if args.probe:
        print(json.dumps(probe()))
        return 0
    if args.model is None or args.output is None:
        parser.error("--model 和 --output 为必填")
    model = args.model.expanduser().resolve()
    output = args.output.expanduser().resolve()
    if not model.is_file():
        raise RenderError("原始模型文件不存在，请重新关联本地模型")
    if model.suffix.lower() not in MODEL_EXTENSIONS:
        raise RenderError("支持 STEP、STL、OBJ、PLY、VTP 模型")
    if output.suffix.lower() != ".png" or output == model:
        raise RenderError("输出必须是与源文件不同的 PNG 文件")
    status = probe()
    if not status["available"]:
        missing = ", ".join(name for name, present in status["dependencies"].items() if not present)
        raise RenderError("缺少本地渲染依赖：" + missing + "；请为当前 Python 安装 cadquery、vtk、numpy")
    import vtk
    started = time.monotonic()
    source_sha = digest_file(model)
    root = Path(__file__).resolve().parents[1]
    data_dir = Path(os.environ.get("REDPILOT_DATA_DIR", str(root / "runtime")))
    cache_root = (args.cache_dir or data_dir / "product-assets" / "render-cache").resolve()
    cache = cache_root / (source_sha + "-v" + str(CACHE_VERSION))
    cache.mkdir(parents=True, exist_ok=True)
    output.parent.mkdir(parents=True, exist_ok=True)
    with (cache / "mesh.lock").open("a") as lock:
        try:
            import fcntl
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        except ImportError:
            pass
        manifest, hit = create_geometry_cache(model, cache, source_sha, vtk)
    prepared = time.monotonic()
    result = render_geometry(cache, manifest, output, args.preset, vtk)
    finished = time.monotonic()
    print(json.dumps({"ok": True, "output": str(output), "width": WIDTH, "height": HEIGHT, "preset": args.preset,
                      "sourceSha256": source_sha, "cacheHit": hit, "engine": "cadquery-vtk", "elapsedSeconds": round(finished - started, 3),
                      "prepareSeconds": round(prepared - started, 3), "renderSeconds": round(finished - prepared, 3), **result}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        sys.exit(1)
