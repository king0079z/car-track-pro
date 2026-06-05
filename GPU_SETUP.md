# CarTrack Pro — GPU Acceleration Setup Guide

Run this guide on the **client's server** to enable full GPU acceleration.
Expected result: 20–30× faster plate detection, handles 20+ cameras simultaneously.

---

## Requirements
- NVIDIA GPU (RTX 3060 / RTX 3070 / RTX 4060 or better)
- Windows 10/11 64-bit OR Ubuntu 22.04 LTS
- Internet connection during setup

---

## Step 1 — Install NVIDIA Drivers

**Windows:**
1. Go to https://www.nvidia.com/drivers
2. Select your GPU model and download the latest Game Ready or Studio driver
3. Install and restart the PC

**Ubuntu:**
```bash
sudo apt update
sudo apt install -y nvidia-driver-535
sudo reboot
```

Verify:
```bash
nvidia-smi
```
You should see your GPU listed with driver version.

---

## Step 2 — Install CUDA Toolkit 12.1

**Windows:**
1. Download from: https://developer.nvidia.com/cuda-12-1-0-download-archive
2. Choose: Windows → x86_64 → 10/11 → exe (local)
3. Run installer (choose Express install)
4. Restart PC after installation

**Ubuntu:**
```bash
wget https://developer.download.nvidia.com/compute/cuda/12.1.0/local_installers/cuda_12.1.0_530.30.02_linux.run
sudo sh cuda_12.1.0_530.30.02_linux.run
echo 'export PATH=/usr/local/cuda/bin:$PATH' >> ~/.bashrc
echo 'export LD_LIBRARY_PATH=/usr/local/cuda/lib64:$PATH' >> ~/.bashrc
source ~/.bashrc
```

Verify:
```bash
nvcc --version
# Should show: release 12.1
```

---

## Step 3 — Install GPU-Accelerated Python Libraries

```bash
# Uninstall CPU-only PyTorch first
pip uninstall torch torchvision torchaudio -y

# Install CUDA 12.1 version of PyTorch
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121

# Verify GPU is detected
python -c "import torch; print('CUDA:', torch.cuda.is_available()); print('GPU:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'None')"
```

---

## Step 4 — Enable GPU in CarTrack Pro

Edit `backend/.env`:

```env
USE_GPU=true
```

---

## Step 5 — Restart the Application

```bash
# Stop current server, then restart
cd "Car Tracking system/backend"
python -m uvicorn app.main:app --host 0.0.0.0 --port 8001
```

Watch the startup logs — you should see:
```
EasyOCR ready ✓ (GPU)
YOLOv8 plate detector ready ✓ (GPU)
```

---

## Expected Performance After GPU Setup

| Task                        | CPU Only   | With RTX 3060  |
|-----------------------------|------------|----------------|
| YOLO scan per frame         | ~150 ms    | **5 ms**       |
| EasyOCR on plate crop       | ~400 ms    | **20 ms**      |
| Frames analyzed per second  | ~2         | **50+**        |
| Max simultaneous cameras    | 6          | **20+**        |
| 12-second video analysis    | ~30 s      | **< 1 s**      |

---

## Troubleshooting

**"CUDA not available" after install:**
- Make sure NVIDIA drivers are installed BEFORE CUDA toolkit
- Restart PC after driver installation
- Check `nvidia-smi` works in terminal

**"Out of memory" error:**
- Reduce batch size by setting `YOLO_IMGSZ=640` in `.env`
- Use a GPU with more VRAM (8GB+ recommended)

**EasyOCR still using CPU:**
- Confirm `USE_GPU=true` in `.env`
- Restart the backend server completely
