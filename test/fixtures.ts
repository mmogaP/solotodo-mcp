import type { CategoryFilter } from '../src/solotodo/filters.js';

/**
 * Recorte real del layout de filtros de la categoría Notebooks (id 1),
 * tomado de `/category_specs_form_layouts/?category=1&website=1`.
 */
export const NOTEBOOK_FILTERS: CategoryFilter[] = [
  {
    id: 1,
    label: 'Marcas',
    name: 'brands',
    type: 'exact',
    continuous_range_step: null,
    continuous_range_unit: null,
    fieldset: 'General',
    choices: [
      { id: 103582, name: 'Acer', value: null },
      { id: 103588, name: 'ASUS', value: null },
      { id: 103586, name: 'Apple', value: null },
      { id: 103620, name: 'Lenovo', value: null },
    ],
  },
  {
    id: 20,
    label: 'Peso',
    name: 'weight',
    type: 'range',
    continuous_range_step: '100.0',
    continuous_range_unit: 'g.',
    fieldset: 'General',
    choices: null,
  },
  {
    id: 7,
    label: 'Cantidad mínima',
    name: 'ram_quantity',
    type: 'gte',
    continuous_range_step: null,
    continuous_range_unit: null,
    fieldset: 'RAM',
    choices: [
      { id: 103181, name: '1 GB', value: '1.00' },
      { id: 103190, name: '4 GB', value: '4.00' },
      { id: 103196, name: '8 GB', value: '8.00' },
      { id: 103202, name: '16 GB', value: '16.00' },
      { id: 103208, name: '32 GB', value: '32.00' },
    ],
  },
  {
    id: 12,
    label: 'Tamaño',
    name: 'screen_size',
    type: 'range',
    continuous_range_step: null,
    continuous_range_unit: null,
    fieldset: 'Pantalla',
    choices: [
      { id: 103123, name: '10"', value: '10.00' },
      { id: 103975, name: '14"', value: '14.00' },
      { id: 103978, name: '15.6"', value: '15.60' },
      { id: 103981, name: '17"', value: '17.00' },
    ],
  },
  {
    id: 355,
    label: '¿Táctil?',
    name: 'screen_touch',
    type: 'exact',
    continuous_range_step: null,
    continuous_range_unit: null,
    fieldset: 'Pantalla',
    choices: null,
  },
  {
    id: 17,
    label: 'Modelo',
    name: 'video_cards',
    type: 'exact',
    continuous_range_step: null,
    continuous_range_unit: null,
    fieldset: 'Tarjeta de video',
    choices: [
      { id: 2000001, name: 'NVIDIA GeForce RTX 4050 (6 GB)', value: null },
      { id: 2000002, name: 'NVIDIA GeForce RTX 4060 (8 GB)', value: null },
      { id: 2000003, name: 'AMD Radeon 610M', value: null },
    ],
  },
];
