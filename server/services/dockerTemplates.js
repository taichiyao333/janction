/**
 * GPU Rental Platform - Docker Template Definitions (Server-side)
 *
 * フロントエンドの DOCKER_TEMPLATES (portal/app.js) と対応。
 * 各テンプレートの実際のDockerイメージ・ポート・環境変数を定義する。
 *
 * イメージは runpod コミュニティイメージ互換形式を利用。
 * プロバイダー側に docker pull 済みであることを前提とする。
 */

const TEMPLATES = {
    pytorch: {
        id: 'pytorch',
        image: 'pytorch/pytorch:2.1.0-cuda12.1-cudnn8-runtime',
        // JupyterLab を標準起動
        cmd: 'bash -c "pip install -q jupyterlab && jupyter lab --ip=0.0.0.0 --port=8888 --no-browser --allow-root --NotebookApp.token=\\"\\" --NotebookApp.password=\\"\\" 2>&1"',
        ports: {
            8888: null,  // JupyterLab (null = auto-assign host port)
        },
        envs: {
            PYTHONUNBUFFERED: '1',
        },
        description: 'PyTorch 2.1 + CUDA 12.1 + JupyterLab',
    },

    comfyui: {
        id: 'comfyui',
        image: 'yanwk/comfyui-boot:cu121',
        cmd: null, // イメージのデフォルトCMDを使用
        ports: {
            8188: null,  // ComfyUI WebUI
            8888: null,  // JupyterLab (同梱の場合)
        },
        envs: {
            CLI_ARGS: '',
        },
        description: 'ComfyUI (Stable Diffusion WebUI) + CUDA 12.1',
    },

    jupyter: {
        id: 'jupyter',
        image: 'jupyter/scipy-notebook:cuda12-python-3.11',
        cmd: null,
        ports: {
            8888: null,
        },
        envs: {
            JUPYTER_ENABLE_LAB: 'yes',
            GRANT_SUDO: 'yes',
            NB_UID: '1000',
        },
        description: 'JupyterLab + scipy + pandas + matplotlib + CUDA',
    },

    ollama: {
        id: 'ollama',
        image: 'ollama/ollama:latest',
        cmd: null,
        ports: {
            11434: null,  // Ollama API
        },
        envs: {
            OLLAMA_HOST: '0.0.0.0',
        },
        description: 'Ollama LLM server (GPU-accelerated)',
    },

    blender: {
        id: 'blender',
        image: 'linuxserver/blender:latest',
        cmd: null,
        ports: {
            3000: null,  // Web UI (KasmVNC)
        },
        envs: {
            PUID: '1000',
            PGID: '1000',
            TZ: 'Asia/Tokyo',
        },
        description: 'Blender 4.x with GPU rendering via KasmVNC',
    },

    base: {
        id: 'base',
        image: 'nvidia/cuda:12.1.0-base-ubuntu22.04',
        cmd: 'bash -c "apt-get update -q && apt-get install -yq python3 python3-pip openssh-server && service ssh start && tail -f /dev/null"',
        ports: {
            22: null,   // SSH
        },
        envs: {
            NVIDIA_VISIBLE_DEVICES: 'all',
        },
        description: 'Ubuntu 22.04 + CUDA 12.1 (base environment)',
    },
};

/**
 * テンプレートIDからテンプレート定義を取得
 * 不明なIDの場合は 'pytorch' にフォールバック
 */
function getTemplate(id) {
    return TEMPLATES[id] || TEMPLATES['pytorch'];
}

/**
 * 全テンプレート一覧を返す
 */
function listTemplates() {
    return Object.values(TEMPLATES);
}

module.exports = { getTemplate, listTemplates, TEMPLATES };
