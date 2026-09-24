# Universal Local GLB Publishing Lab

Project gồm một pipeline Node.js chạy hoàn toàn cục bộ và một website tĩnh dùng Google `<model-viewer>`. Pipeline nhận file GLB ở bất kỳ đường dẫn nào, tạo artifact đã tối ưu/kiểm định trong `dist/current`, rồi viewer dùng artifact đó để preview.

Pipeline runtime không dùng AI. Codex chỉ hỗ trợ phát triển mã nguồn; lệnh publish không gọi dịch vụ AI và không cần phân tích thủ công cho từng model.

## Cài đặt

Yêu cầu Node.js 18 trở lên:

```bash
npm install
```

Không cần Blender, React, framework, Git LFS hoặc build frontend.

## QUICK TEST (Windows)

Kéo một file `.glb` từ Windows Explorer và thả vào:

```text
TEST_MODEL.bat
```

BAT sẽ publish/validate file, in summary ngắn và mở local preview. Đây là luồng **chỉ chạy local**: không `git add`, commit, push hoặc deploy. Dừng preview bằng `Ctrl+C`.

## QUICK DEPLOY (Windows)

Kéo một file `.glb` từ Windows Explorer và thả vào:

```text
DEPLOY_MODEL.bat
```

BAT sẽ publish/validate, chạy GitHub deploy an toàn cho artifact trong `dist/current`, rồi in URL Viewer, Model và Metadata có cache key từ SHA output. Deploy chỉ stage các file artifact cần thiết; các thay đổi working tree không liên quan được giữ nguyên.

Cả hai BAT đều xác định project root từ vị trí của chính BAT, xử lý đường dẫn tuyệt đối/có khoảng trắng, và không sửa, đổi tên hoặc xóa GLB nguồn. Nếu mở BAT bằng double-click mà không kéo file vào, cửa sổ sẽ hướng dẫn kéo một file `.glb` rồi dừng lại.

Hai workflow này chạy bằng Node.js và các công cụ glTF cục bộ, hoàn toàn không gọi AI/LLM hay inference service.

## Workflow cơ bản

```text
GLB nguồn ở bất kỳ vị trí nào
↓
npm run publish -- "<source.glb>"
↓
preflight
↓
complexity classification
↓
viewer-safe optimization
↓
validation
↓
dist/current
↓
npm run preview
↓
viewer?model=./dist/current/model.glb
```

### 1. Publish

Ví dụ Windows:

```bash
npm run publish -- "D:\Models\villa.glb"
```

Đường dẫn tương đối cũng được hỗ trợ:

```bash
npm run publish -- ".\exports\interior.glb"
```

Source không cần đổi tên hoặc chép vào project. Publisher chỉ đọc source và tạo một bản làm việc trong thư mục tạm riêng. Source không bị ghi đè, đổi tên hay xóa.

Publish thực hiện:

1. Kiểm tra đường dẫn, phần mở rộng và GLB header.
2. Chạy Khronos glTF Validator trên source.
3. Kiểm tra scene, primitive, số liệu không hữu hạn và world bounds.
4. Báo center, size, khoảng cách tới origin, texture và extension.
5. Chạy profile tối ưu `viewer-safe`.
6. Kiểm định candidate trước/sau.
7. Chỉ sau khi mọi kiểm định thành công mới thay `dist/current`.

Nếu publish thất bại, artifact thành công trước đó trong `dist/current` được giữ nguyên.

### 2. Output

```text
dist/
└── current/
    ├── model.glb
    └── metadata.json
```

`metadata.json` chứa SHA-256, kích thước byte, complexity class, optimization path, timing từng stage, counts trước/sau, bounds, texture summary, extensions, profile và validation warnings. File không chứa timestamp, đường dẫn máy, Git metadata hoặc nhãn do AI tạo. Các count và lựa chọn path là deterministic; timing là số đo thực tế nên có thể thay đổi nhẹ giữa các lần chạy.

Trong `dist/`, chỉ `dist/current/model.glb` và `dist/current/metadata.json` được phép đưa lên Git để GitHub Pages phục vụ đúng artifact đã kiểm định. Các artifact tạm hoặc output khác trong `dist/` vẫn bị loại khỏi Git. Deploy adapter đồng thời chép model đã kiểm định sang `model.glb` ở project root để giữ fallback tương thích cũ.

File `.nojekyll` ở root yêu cầu GitHub Pages phục vụ trực tiếp website tĩnh và các binary GLB, không đưa cây output qua bước xử lý Jekyll.

### 3. Preview

Sau khi publish thành công:

```bash
npm run preview
```

Preview mở:

```text
http://localhost:8000/?model=./dist/current/model.glb
```

Preview chỉ phục vụ artifact đã publish. Nó không:

- tìm hoặc tối ưu `model-new.glb`;
- ghi đè/xóa GLB nguồn;
- thay `dist/current/model.glb`;
- commit hoặc push Git.

Preview vẫn chèn Lighting Studio cục bộ. Save Lighting chỉ ghi `lighting-config.json` và bake thuộc tính ánh sáng vào production viewer; không chỉnh model, material hoặc texture.

### Chất lượng hiển thị và hiệu năng

Viewer có ba profile runtime, không sửa GLB và không giảm polygon:

- `High`: giữ độ phân giải render đầy đủ, bóng đổ theo cấu hình và sketch overlay tối đa DPR 2.
- `Balanced`: cho phép `<model-viewer>` tự hạ render scale tới 0.65 khi khung hình chậm, giảm nhẹ bóng đổ và giới hạn sketch overlay ở DPR 1.5.
- `Mobile`: cho phép hạ render scale tới 0.35, tắt bóng đổ động, vẫn giữ environment đã chọn và giới hạn sketch overlay ở DPR 1.

Mặc định `Auto` chọn profile bằng quy tắc cố định dựa trên thiết bị (touch/mobile, kích thước màn hình, DPR) và độ phức tạp trong `dist/current/metadata.json` (rendered triangles, draw calls, nodes và texture GPU ước tính). Với artifact `5towers`, desktop chọn `Balanced`; Galaxy Tab S9 dự kiến chọn `Mobile`. Có thể ép profile khi kiểm thử:

```text
?quality=high
?quality=balanced
?quality=mobile
?quality=auto
```

Lighting Studio trong local preview có dropdown **Quality** và phần debug cho biết profile đang được chọn, DPR/render scale thực tế, draw calls, triangles, texture GPU ước tính và thời gian load. Production không có panel này; trạng thái vẫn có thể đọc trong DevTools qua `window.__viewerQuality.getState()`.

Hai preset hiển thị phục vụ so sánh fidelity:

- `SketchUp-like / Faithful`: environment trung tính, tone mapping trung tính, exposure 1.0 và bóng mềm vừa phải.
- `Presentation`: dùng đúng cấu hình đã lưu trong `lighting-config.json`.

Mặc định production vẫn là `Presentation` để không âm thầm thay đổi lighting đã duyệt. Có thể kiểm tra preset trung tính bằng `?display=faithful` hoặc chọn trực tiếp trong Lighting Studio. Tham số này chỉ thay cách chiếu sáng/tone mapping; không sửa material, texture hay GLB.

Các ngưỡng texture ghi trong profile là ngân sách xuất bản tham khảo, không phải resize runtime. Trình duyệt luôn giải nén texture WebP lên GPU; đổi profile không thể giảm kích thước texture đã nằm trong GLB. Muốn thay ngân sách texture phải publish lại từ source trong một sprint riêng và kiểm tra hình ảnh trước/sau.

Để không tự mở trình duyệt:

```bash
npm run preview -- --no-open
```

Để review từ Galaxy Tab S9 trên cùng mạng Wi-Fi:

```bash
npm run preview:lan
```

Terminal sẽ in cả URL `Local` và một hoặc nhiều URL `LAN`. Mở URL `LAN` trên Tab S9. Windows Firewall có thể hỏi quyền cho Node.js; chỉ cho phép trên **Private networks**. Laptop và tablet phải ở cùng Wi-Fi và mạng không được bật client isolation.

Cách tương đương khi cần truyền host trực tiếp:

```bash
npm run preview -- --host 0.0.0.0
```

Đổi port bằng biến môi trường `PREVIEW_PORT` nếu cần.

## Viewer model parameter

Viewer hỗ trợ:

```text
?model=<relative-or-http-url>
```

Ví dụ:

```text
http://localhost:8000/?model=./dist/current/model.glb
https://example.com/viewer/?model=https://cdn.example.com/villa.glb
```

Chỉ URL `http:` và `https:` được chấp nhận. GLB ở domain khác phải được server nguồn cho phép CORS. Khi không có tham số `model`, viewer giữ fallback tương thích cũ là `./model.glb`.

Spatial sketch reference dùng URL model đã resolve làm identity thay vì giả định `surface:model.glb`.

## Chế độ nhìn kiến trúc

Thanh công cụ có ba chế độ tập trung vào thao tác kiến trúc:

- `Perspective`: phối cảnh tự do, orbit, pan, zoom và double-click/double-tap focus như viewer hiện tại.
- `ISO`: góc isometric chuẩn 45°/35,264°, khóa hướng nhìn; kéo một ngón/chuột để pan và pinch/wheel để zoom. Nhấn ISO lần nữa để phục hồi góc canonical.
- `2D`: mặt đứng gần trực giao theo hướng ngang hiện tại, khóa orbit; kéo để pan và pinch/wheel để zoom.

`<model-viewer>` 4.0 không cung cấp public API để thay camera renderer thành `OrthographicCamera`. Vì vậy 2D và ISO dùng phép chiếu near-orthographic với FOV 1° và tự bù camera radius để giữ framing. Cách này giữ sketch overlay đồng bộ qua public camera API, nhưng vẫn còn một lượng perspective convergence rất nhỏ. Trạng thái nội bộ có thể kiểm tra bằng `window.__viewerViewMode.getState()`.

## Profile tối ưu viewer-safe

Publisher phân loại model bằng primitive, node, mesh, material, accessor, số triangle trung bình trên primitive và tỷ lệ hình học lặp lại:

- `SMALL`: cleanup tối thiểu; bỏ qua join, flatten và consolidation tốn phí.
- `MEDIUM`: pipeline an toàn tiêu chuẩn.
- `LARGE`: exact material dedup rồi primitive consolidation theo mesh, prune, dedup có mục tiêu, flatten và instancing.
- `HIGHLY_FRAGMENTED`: fast path giống `LARGE`, được chọn khi primitive/material/accessor vượt ngưỡng hoặc primitive rất nhỏ và phân mảnh.

Optimizer hiện làm:

- deduplicate material bằng so sánh sâu, chỉ bỏ qua tên exporter;
- với model lớn/phân mảnh, merge primitive tam giác chỉ khi cùng material identity, mode, indexed state, index component type, attribute semantics/layout và không có morph target;
- prune resource không dùng;
- deduplicate accessor/mesh có mục tiêu sau consolidation để tránh hashing khối lượng lớn trước khi giảm fragmentation;
- flatten transform an toàn và dùng `EXT_mesh_gpu_instancing` cho geometry lặp lại;
- resize texture lớn hơn 2048 px, giữ tỷ lệ;
- chuyển JPEG/PNG sang WebP;
- dùng quality 82 cho texture màu sRGB;
- dùng WebP lossless cho data texture;
- giữ nguyên rendered triangle count.

WebP effort dùng thang 0–100 của glTF Transform và được đặt thành 100, tương ứng effort 6 của Sharp/libwebp.

Profile chưa dùng Draco, Meshopt, KTX2, LOD hoặc geometry simplification.

## Validation

Preflight và candidate validation kiểm tra:

- GLB 2.0 header/chunk hợp lệ;
- Khronos glTF Validator không có error;
- có scene và ít nhất một scene-reachable primitive với POSITION;
- accessor không chứa NaN/Infinity;
- bounds hữu hạn;
- rendered triangle count không đổi;
- tổng số element `POSITION`, `NORMAL` và `TEXCOORD_0` theo scene không đổi;
- bounds trước/sau không dịch chuyển vượt tolerance;
- core material factors vẫn tồn tại;
- layout các texture slot và texture transform vẫn tồn tại;
- transparency được giữ khi có unique texture identity đáng tin cậy;
- output texture không vượt giới hạn profile;
- optimizer không thêm required extension ngoài allowlist của profile.

Model có kích thước hoặc vị trí bất thường chỉ tạo warning nếu vẫn có thể publish an toàn.

## Repeatability

Với cùng source, cùng dependency lockfile, cùng môi trường và cùng profile, chạy publish hai lần phải cho cùng SHA-256 của `dist/current/model.glb` và cùng các count/decision fields. `preprocessingTimingsMs` là telemetry thực tế nên không byte-identical giữa các lần chạy.

- SHA-256 của `dist/current/model.glb`;
- complexity class, optimization path và các count trước/sau.

Native codec có thể cho output khác giữa hệ điều hành hoặc phiên bản Sharp/libwebp khác nhau. `package-lock.json` cần được giữ để cố định dependency cho mỗi môi trường.

## Deploy GitHub Pages

Sau khi publish và review bằng preview:

```bash
npm run deploy
```

Deploy là adapter riêng, không phải publisher. Nó:

1. Xác minh `dist/current` khớp metadata.
2. Yêu cầu preview receipt còn khớp.
3. Chép artifact đã kiểm định sang `./model.glb` theo cơ chế rollback an toàn.
4. Kiểm tra production viewer bằng local static server.
5. Chỉ stage allowlist file của project.
6. Commit `dist/current/model.glb`, `dist/current/metadata.json` cùng các file production cần thiết rồi push `origin/main`.
7. In URL viewer, model và metadata chính xác, kèm cache key lấy từ SHA-256 của output.

Phần này vẫn cố ý phụ thuộc Git, branch `main`, remote `origin`, giới hạn file 100 MiB và cấu trúc URL GitHub Pages. Đây là adapter legacy, không nằm trong publisher core.

Để bật GitHub Pages: vào **Settings → Pages → Deploy from a branch**, chọn branch **main** và thư mục **/ (root)**.

Project site có dạng:

```text
https://YOUR_USERNAME.github.io/REPOSITORY/
```

Với repository hiện tại, URL kiểm thử trên thiết bị khác là:

```text
https://ktsnminhtri-wq.github.io/3d-viewer-template/?model=./dist/current/model.glb&v=<output-sha-short>
```

Tham số `v` được viewer chuyển tiếp vào request tải GLB, giúp tránh cache model cũ. SHA rút gọn được in tự động sau mỗi lần deploy. GitHub Pages có thể cần vài phút sau khi push để cập nhật; nếu vẫn thấy bản cũ, mở URL mới được in ra hoặc refresh mạnh/xóa cache của trình duyệt.

## Kiểm thử một GLB thứ hai

```bash
npm run publish -- "D:\Models\tower.glb"
npm run preview
```

Kiểm tra `dist/current/metadata.json`, mở URL preview được in ra, thử pan/zoom/orbit trong các chế độ 2D, ISO, Perspective, material, transparency và spatial sketch. Source `D:\Models\tower.glb` phải giữ nguyên SHA, tên và vị trí.

## Giới hạn đã biết

- GLB có external resource tương đối nằm trong cùng thư mục source được chép vào workspace và embed lại; URL resource từ xa hoặc đường dẫn thoát khỏi thư mục source bị từ chối.
- Chưa có visual regression bằng screenshot.
- Transparency chỉ được so sánh nghiêm ngặt khi texture có tên duy nhất đáng tin cậy; trường hợp khác được ghi warning.
- Byte-for-byte determinism áp dụng cho `model.glb` trong môi trường đã kiểm thử; telemetry timing trong metadata thay đổi theo từng lần chạy và native codec khác phiên bản có thể tạo output khác.
- Viewer và sketch vẫn tải model-viewer/Three.js từ CDN, nên preview UI cần Internet.
- GitHub deploy vẫn là adapter một repository; publisher core không có coupling Git/GitHub.

## Prototype hiệu năng cho model kiến trúc lớn

Prototype Direct Three.js nằm riêng tại `experimental/large-model-viewer` và
không tham gia production workflow. Dùng lệnh sau để tạo baseline, bản
`EXT_mesh_gpu_instancing`, ba biến thể edge và bản primitive-consolidated từ
một GLB chỉ-đọc:

```powershell
npm run experimental:build -- "D:\GLB-TEST\5towers.glb"
npm run experimental:preview
```

Để test trên thiết bị cùng Wi-Fi:

```powershell
npm run experimental:lan
```

Server in URL LAN ở cổng `8100`, giữ safe allowlist và không deploy. Chi tiết
phép đo, các URL so sánh, partition A–E và giới hạn prototype được ghi tại
`experimental/large-model-viewer/README.md`.

Khi `dist/current` đã có artifact production hợp lệ, benchmark viewer có thêm URL local:

```text
http://localhost:8100/?variant=production&quality=balanced&audit=1
```

Route này chỉ đọc `dist/current/model.glb` và `metadata.json`; experimental viewer vẫn tách khỏi production viewer và không tham gia deploy.
