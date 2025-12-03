import axios from 'axios';

const api = axios.create({
  baseURL: 'http://localhost:4000/api',
});

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


