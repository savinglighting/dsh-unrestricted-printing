# 依赖体检报告

生成时间：2026-10-18 22:55:49

| 状态 | 项目 | 路径 / 说明 | 缺失时的修法 |
|---|---|---|---|
| ✓ | Node.js ≥18（网关运行时） | C:\Program Files\nodejs\node.exe；0.08 GB；版本 v24.13.0 | `winget install OpenJS.NodeJS.LTS   # 或 https://nodejs.org/dist/` |
| ✓ | 插件本体 | D:\DSWorkPlace\dsh-unrestricted-printing；76 文件 / 0.01 GB；dsh-unrestricted-printing |  |
| ✓ | 调度网关（gateway\index.js） | D:\DSWorkPlace\dsh-unrestricted-printing\gateway；25 文件 / 0 GB | `插件包不完整：重新解压 Releases 里的 zip / 重装 npm 包` |
| ✓ | Stable Diffusion WebUI（launch.py） | D:\SD.4.8；131,637 文件 / 85.18 GB |  |
| ✓ | SD checkpoint（主模型） | D:\SD.4.8\models\Stable-diffusion\wai光辉Illustrious_v17.safetensors；6.46 GB | `Civitai/HF 下载 .safetensors 放进 models\Stable-diffusion\（示例：AWPainting_v1.2 / anything-v5）` |
| ✓ | VAE（可选，颜色/细节修正） | D:\SD.4.8\models\VAE\vae-ft-mse-840000-ema-pruned.safetensors；0.31 GB | `https://huggingface.co/stabilityai/sd-vae-ft-mse-original （镜像 hf-mirror.com）` |
| ✓ | LoRA（可选：细节/负面词/手部） | D:\SD.4.8\models\Lora；38 文件 / 2.93 GB；11 个文件 | `Civitai 下载 add_detail / easynegative / badhandv4 放进 models\Lora\` |
| ✓ | CLIP 文本编码器 clip-vit-large-patch14（点图必需） | D:\SD.4.8\.cache\huggingface\hub\models--openai--clip-vit-large-patch14\snapshots\8d052a0f05efbaefbc9e8786ba291cfdf93e5bff\model.safetensors；1.59 GB |  |
| ✓ | Python 依赖 pin（transformers 4.30.2 / tokenizers 0.13.3 / hf_hub 0.23.5） | D:\SD.4.8\python\python.exe；0 GB | `& "D:\SD.4.8\python\python.exe" -m pip install --no-deps --timeout 60 -i https://pypi.tuna.tsinghua.edu.cn/simple transformers==4.30.2 tokenizers==0.13.3 huggingface_hub==0.23.5` |
| ✓ | ADetailer 扩展（默认面部修复） | D:\SD.4.8\extensions\adetailer；67 文件 / 0 GB | `WebUI → Extensions → Install from URL：https://github.com/Bing-su/adetailer` |
| ✓ | ComfyUI（main.py） | D:\ComfyUI；62,966 文件 / 19.2 GB |  |
| ✓ | ComfyUI 独立 venv（torch cu128） | D:\ComfyUI\venv\Scripts\python.exe；0 GB；torch 2.11.0+cu128 12.8 |  |
| ✓ | 自定义节点 ComfyUI-GGUF | D:\ComfyUI\custom_nodes\ComfyUI-GGUF；21 文件 / 0 GB | `git clone https://github.com/city96/ComfyUI-GGUF custom_nodes\ComfyUI-GGUF` |
| ✓ | Qwen-Image UC Q4_K_M GGUF（4.29G） | D:\ComfyUI\models\unet\qwen-image-2.1-UC-Q4_K_M.gguf；4.29 GB | `HF QuantStack/Qwen-Image-2.1-UC-GGUF → models\unet\（镜像：hf-mirror.com）` |
| ✓ | Qwen 文本编码器（8.71G，需整体入内存） | D:\ComfyUI\models\text_encoders\qwen3vl_8b_int8_convrot.safetensors；8.71 GB | `同仓库 text_encoders 文件 → models\text_encoders\；可用内存 < 7G 会崩（故障 ⑤）` |
| ✓ | Qwen VAE（0.63G） | D:\ComfyUI\models\vae\qwen_image_2.1_vae_bf16.safetensors；0.63 GB | `同仓库 vae 文件 → models\vae\` |
| ⚠ | Krea2_Q4 权重（可选） | D:\ComfyUI\models\unet；2 文件 / 4.29 GB；未装则该档位明确报 no-model（不崩） | `按你手上的 Krea2 发布渠道下载 → models\unet\krea2_q4.safetensors` |
| ✓ | Ollama（本地视觉质检运行时，可选） | d:\ollama\ollama.exe；0.03 GB |  |
| ✓ | qwen3-vl:8b 视觉质检模型（6.1G，可选） |  | `ollama pull qwen3-vl:8b` |
| ⚠ | rosbridge（ws://localhost:9090，可选） | 未运行 → 监控自动降级 nvidia-smi（本机实测即此路径） | `装 rosbridge_suite 并 ros2 launch rosbridge_server rosbridge_websocket_launch.xml` |
| ✓ | 网关在跑（http://127.0.0.1:8799） |  | `node gateway\index.js` |
| ✓ | 产物目录 | D:\DSWorkPlace\SD-Picture；229 文件 / 0.18 GB | `New-Item -ItemType Directory -Force 'D:\DSWorkPlace\SD-Picture'` |
| ✓ | NVIDIA 驱动/显卡 | C:\windows\system32\nvidia-smi.exe；0 GB；NVIDIA GeForce RTX 5060 Laptop GPU, 8151 MiB |  |

合计 23 项：OK 21 / WARN 2 / MISSING 0
