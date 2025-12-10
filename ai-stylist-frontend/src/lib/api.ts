import axios from 'axios';

const api = axios.create({
  baseURL: 'http://localhost:4000/api',
  timeout: 70000, // ~70s for normal calls
});

// Long-timeout instance for VTON requests (can take several minutes)
const apiLong = axios.create({
  baseURL: 'http://localhost:4000/api',
  timeout: 300000, // 5 minutes
});

// Add request interceptor for logging
api.interceptors.request.use(
  (config) => {
    console.log(`[API] ${config.method?.toUpperCase()} ${config.baseURL}${config.url}`, config.data);
    return config;
  },
  (error) => {
    console.error('[API] Request error:', error);
    return Promise.reject(error);
  }
);

// Add response interceptor for logging
api.interceptors.response.use(
  (response) => {
    console.log(`[API] Response from ${response.config.url}:`, response.status, response.data);
    return response;
  },
  (error) => {
    console.error('[API] Response error:', error.response?.status, error.response?.data || error.message);
    if (error.code === 'ECONNREFUSED') {
      error.message = 'Cannot connect to backend server. Please make sure the server is running on port 4000.';
    } else if (error.code === 'ETIMEDOUT') {
      error.message = 'Request timed out. The server may be slow or not responding.';
    }
    return Promise.reject(error);
  }
);

export const suggestOutfits = async (query: string) => {
  const ts = Date.now();
  const { data } = await api.post(`/suggest?t=${ts}`, { message: query }, {
    headers: { 'Cache-Control': 'no-cache' },
  });
  return data;
};

export const generateTryOn = async (userImage: File, product: any) => {
  const formData = new FormData();
  formData.append('user_image', userImage);
  formData.append('query', product?.title || '');
  formData.append('product_image_path', product?.image_url || '');

  const ts = Date.now();
  const { data } = await apiLong.post(`/try-on?t=${ts}`, formData, {
    headers: {
      'Content-Type': 'multipart/form-data',
      'Cache-Control': 'no-cache',
    },
  });

  return data;
};

export const generateOutfitTryOn = async (userImageBase64: string, productUrls: string[]) => {
  const ts = Date.now();
  const { data } = await apiLong.post(`/try-on-outfit?t=${ts}`, {
    userImage: userImageBase64,
    productUrls: productUrls,
  }, {
    headers: { 'Cache-Control': 'no-cache' },
  });

  return data;
};

export const deleteProduct = async (category: string, id: string) => {
  const { data } = await api.delete(`/products/${category}/${id}`);
  return data;
};


