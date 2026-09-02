/**
 * AI 短剧生产工具集（导演工作台）
 *
 * 工具返回 { actionType, params, summary } 指令对象，由前端
 * 导演工作台接收后驱动"剧本 → 分镜 → 生图 → 生视频 → 配音"流水线。
 * 逻辑恢复自 3.4.1 镜像反混淆代码。
 */
import { z } from 'zod';
import { tool } from '@shareai-lab/kode-sdk';

/** 素材类型：角色 / 场景 / 道具 */
const assetTypeEnum = z.enum(['character', 'scene', 'prop']);
const assetTypesOptional = z.array(assetTypeEnum).optional();

/** 镜头选择范围：全部 / 指定镜头 / 连续区间 */
const shotScopeSchema = z.object({
  scope: z.enum(['all', 'shot']).optional(),
  shotId: z.string().optional(),
  shotIndex: z.number().optional(),
  shotRange: z.object({ start: z.number(), end: z.number() }).optional(),
});

/** 素材定位：按类型 + ID/名称定位 */
const assetTargetSchema = z.object({
  assetType: assetTypeEnum,
  scope: z.enum(['all', 'ids', 'names']).optional(),
  assetId: z.string().optional(),
  assetIds: z.array(z.string()).optional(),
  assetName: z.string().optional(),
  assetNames: z.array(z.string()).optional(),
});

/**
 * 构造短剧流水线动作指令
 * @param {string} actionType - 动作类型（如 generate_video）
 * @param {Record<string, unknown>} params - 动作参数
 * @param {string} summary - 给用户看的动作摘要
 * @returns {{ actionType: string, params: Record<string, unknown>, summary: string }}
 */
const dramaAction = (actionType, params, summary) => ({
  actionType,
  params: params || {},
  summary,
});

/** 构建短剧生产工具实例列表 */
export const buildDramaTools = () => [
  tool({
    name: 'analyze_script',
    description: 'Analyze or re-analyze the current episode script into structured script data.',
    parameters: z.object({ force: z.boolean().optional() }),
    execute: async (args) => dramaAction('analyze_script', args, 'Analyze the current script structure.'),
  }),
  tool({
    name: 'enrich_visuals',
    description: 'Enrich characters, scenes, and props with visual prompt details.',
    parameters: z.object({ force: z.boolean().optional() }),
    execute: async (args) => dramaAction('enrich_visuals', args, 'Enrich the project visual descriptions.'),
  }),
  tool({
    name: 'generate_shots',
    description: 'Generate or regenerate the shot list from the current structured script.',
    parameters: z.object({ force: z.boolean().optional() }),
    execute: async (args) => dramaAction('generate_shots', args, 'Generate the shot list for the episode.'),
  }),
  tool({
    name: 'generate_asset_images',
    description: 'Generate reference images for characters, scenes, or props.',
    parameters: assetTargetSchema,
    execute: async (args) => dramaAction(
      'generate_asset_images',
      args,
      `Generate ${args.assetType} reference images.`
    ),
  }),
  tool({
    name: 'generate_keyframes',
    description: 'Generate shot keyframes for one or more shots.',
    parameters: shotScopeSchema.extend({
      frameType: z.enum(['start', 'end', 'both']).optional(),
      aspectRatio: z.string().optional(),
    }),
    execute: async (args) => dramaAction('generate_keyframes', args, 'Generate keyframes for the selected shots.'),
  }),
  tool({
    name: 'generate_nine_grid',
    description: 'Generate storyboard grid previews for one or more shots.',
    parameters: shotScopeSchema.extend({
      panelCount: z.union([z.literal(4), z.literal(6), z.literal(9)]).optional(),
      autoImage: z.boolean().optional(),
    }),
    execute: async (args) => dramaAction('generate_nine_grid', args, 'Generate storyboard grid previews.'),
  }),
  tool({
    name: 'generate_video',
    description: 'Generate final video clips for one or more shots.',
    parameters: shotScopeSchema.extend({
      aspectRatio: z.string().optional(),
      duration: z.number().optional(),
      modelId: z.string().optional(),
      inputMode: z.string().optional(),
    }),
    execute: async (args) => dramaAction('generate_video', args, 'Generate video clips for the selected shots.'),
  }),
  tool({
    name: 'auto_production',
    description: 'Build and execute an automatic production plan for selected shots.',
    parameters: shotScopeSchema.extend({
      recommendWithAI: z.boolean().optional(),
      onlyRemaining: z.boolean().optional(),
      aspectRatio: z.string().optional(),
    }),
    execute: async (args) => dramaAction('auto_production', args, 'Run the automatic production workflow.'),
  }),
  tool({
    name: 'sync_project_assets',
    description: 'Sync linked episode assets from the project asset library.',
    parameters: z.object({
      assetType: assetTypeEnum.optional(),
      assetTypes: assetTypesOptional,
      mode: z.enum(['outdated', 'all-linked']).optional(),
    }),
    execute: async (args) => dramaAction('sync_project_assets', args, 'Sync linked project assets into the episode.'),
  }),
  tool({
    name: 'generate_dubbing',
    description: 'Generate dubbing audio for one or more shots.',
    parameters: shotScopeSchema.extend({
      mode: z.enum(['narration', 'dialogue']).optional(),
      text: z.string().optional(),
      modelId: z.string().optional(),
      voice: z.string().optional(),
      overwrite: z.boolean().optional(),
    }),
    execute: async (args) => dramaAction('generate_dubbing', args, 'Generate dubbing audio for the selected shots.'),
  }),
  tool({
    name: 'match_project_assets',
    description: 'Find and reuse matching assets from the project asset library.',
    parameters: z.object({
      assetType: assetTypeEnum.optional(),
      assetTypes: assetTypesOptional,
    }),
    execute: async (args) => dramaAction('match_project_assets', args, 'Match and reuse project assets.'),
  }),
  tool({
    name: 'edit_script',
    description: 'Edit the current script metadata or raw script text.',
    parameters: z.object({
      changes: z.object({
        rawScript: z.string().optional(),
        title: z.string().optional(),
        genre: z.string().optional(),
        logline: z.string().optional(),
        targetDuration: z.string().optional(),
        language: z.string().optional(),
        visualStyle: z.string().optional(),
      }).partial().passthrough(),
      reparse: z.boolean().optional(),
    }),
    execute: async (args) => dramaAction('edit_script', args, 'Edit the episode script or metadata.'),
  }),
  tool({
    name: 'edit_shot',
    description: 'Edit one or more shots, including dialogue, camera, prompts, and linked assets.',
    parameters: shotScopeSchema.extend({
      changes: z.object({
        actionSummary: z.string().optional(),
        dialogue: z.string().optional(),
        cameraMovement: z.string().optional(),
        shotSize: z.string().optional(),
        sceneId: z.string().optional(),
        sceneName: z.string().optional(),
        characterIds: z.array(z.string()).optional(),
        characterNames: z.array(z.string()).optional(),
        addCharacterIds: z.array(z.string()).optional(),
        addCharacterNames: z.array(z.string()).optional(),
        removeCharacterIds: z.array(z.string()).optional(),
        removeCharacterNames: z.array(z.string()).optional(),
        propIds: z.array(z.string()).optional(),
        propNames: z.array(z.string()).optional(),
        addPropIds: z.array(z.string()).optional(),
        addPropNames: z.array(z.string()).optional(),
        removePropIds: z.array(z.string()).optional(),
        removePropNames: z.array(z.string()).optional(),
        startPrompt: z.string().optional(),
        endPrompt: z.string().optional(),
        videoPrompt: z.string().optional(),
        videoModel: z.string().optional(),
        videoInputMode: z.enum(['keyframes', 'storyboard-grid']).optional(),
      }).partial().passthrough(),
    }),
    execute: async (args) => dramaAction('edit_shot', args, 'Edit the selected shot configuration.'),
  }),
  tool({
    name: 'edit_asset',
    description: 'Edit character, scene, or prop definitions and prompts.',
    parameters: assetTargetSchema.extend({
      changes: z.object({
        name: z.string().optional(),
        gender: z.string().optional(),
        age: z.string().optional(),
        personality: z.string().optional(),
        coreFeatures: z.string().optional(),
        location: z.string().optional(),
        time: z.string().optional(),
        atmosphere: z.string().optional(),
        category: z.string().optional(),
        description: z.string().optional(),
        visualPrompt: z.string().optional(),
        negativePrompt: z.string().optional(),
      }).partial().passthrough(),
    }),
    execute: async (args) => dramaAction('edit_asset', args, `Edit ${args.assetType} asset definitions.`),
  }),
  tool({
    name: 'edit_prompt_template',
    description: 'Set or clear a prompt template field override.',
    parameters: z.object({
      path: z.string().optional(),
      query: z.string().optional(),
      mode: z.enum(['set', 'clear']).optional(),
      value: z.string().optional(),
    }),
    execute: async (args) => dramaAction('edit_prompt_template', args, 'Edit a prompt template override.'),
  }),
];
