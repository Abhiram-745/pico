import { credential } from './composio-secret.mjs';
export const loadGeminiKey = () => credential('Halo/Gemini', 'load');
export const saveGeminiKey = key => credential('Halo/Gemini', 'save', key);
