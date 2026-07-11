'use client';

import { Settings, Video } from 'lucide-react';
import type { QualityPreset, ConversionSettings as SettingsType } from '@/types/converter';
import { QUALITY_PRESETS } from '@/types/converter';

interface ConversionSettingsProps {
  settings: SettingsType;
  onSettingsChange: (settings: SettingsType) => void;
}

export function ConversionSettings({ settings, onSettingsChange }: ConversionSettingsProps) {
  const handleQualityChange = (quality: QualityPreset) => {
    onSettingsChange({ ...settings, quality });
  };

  return (
    <div className="bg-slate-50 rounded-xl p-4 space-y-4">
      <div className="flex items-center gap-2.5">
        <div className="w-8 h-8 rounded-lg bg-white flex items-center justify-center shadow-sm">
          <Settings className="w-4 h-4 text-slate-500" />
        </div>
        <h3 className="text-sm font-medium text-slate-700">Dönüşüm Ayarları</h3>
      </div>

      <div className="space-y-3">
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-2.5">
            Video Kalitesi
          </label>
          <div className="grid grid-cols-3 gap-2">
            {(Object.keys(QUALITY_PRESETS) as QualityPreset[]).map((preset) => (
              <button
                key={preset}
                onClick={() => handleQualityChange(preset)}
                className={`
                  py-2.5 px-3 rounded-xl text-sm font-medium transition-all
                  ${settings.quality === preset
                    ? 'bg-[#376BFC] text-white shadow-sm'
                    : 'bg-white text-slate-600 border border-slate-200 hover:border-[#376BFC]/50'
                  }
                `}
              >
                {QUALITY_PRESETS[preset].label}
              </button>
            ))}
          </div>
        </div>

        <div className="pt-3 border-t border-slate-100">
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <Video className="w-4 h-4 shrink-0" />
            <span>
              <span className="font-medium text-slate-600">H.264</span> – Telefonlar, 
              bilgisayarlar ve sosyal medya platformlarıyla uyumlu
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
