import axios from 'axios';

const api = axios.create({
  baseURL: 'http://localhost:4000/api',
  timeout: 30000, // 30 seconds timeout
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
  const { data } = await api.post('/suggest', { message: query });
  return data;
};

export const generateTryOn = async (userImage: File, product: any) => {
  const formData = new FormData();
  formData.append('user_image', userImage);
  formData.append('query', product?.title || '');
  formData.append('product_image_path', product?.image_url || '');

  const { data } = await api.post('/try-on', formData, {
    headers: {
      'Content-Type': 'multipart/form-data',
    },
  });

  return data;
};

export const generateOutfitTryOn = async (userImageBase64: string, productUrls: string[]) => {
  const { data } = await api.post('/try-on-outfit', {
    userImage: userImageBase64,
    productUrls: productUrls,
  });

  return data;
};

export const deleteProduct = async (category: string, id: string) => {
  const { data } = await api.delete(`/products/${category}/${id}`);
  return data;
};


