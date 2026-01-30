// ui/src/apps/settings/hooks/useSettingsForms.ts

import { useState } from 'react';

export interface CatalogFormState {
  name: string;
  filename: string;
}

export interface BookmarkFormState {
  name: string;
  startTime: string;
  endTime: string;
  maxFrames: string;
}

export interface NewBookmarkFormState {
  profileId: string;
  name: string;
  startTime: string;
  endTime: string;
  maxFrames: string;
}

export function useSettingsForms() {
  // Catalog dialog form (used for both duplicate and edit)
  const [catalogName, setCatalogName] = useState('');
  const [catalogFilename, setCatalogFilename] = useState('');

  // Bookmark dialog form (for editing)
  const [bookmarkName, setBookmarkName] = useState('');
  const [bookmarkStartTime, setBookmarkStartTime] = useState('');
  const [bookmarkEndTime, setBookmarkEndTime] = useState('');
  const [bookmarkMaxFrames, setBookmarkMaxFrames] = useState('');

  // New bookmark dialog form (for creating)
  const [newBookmarkProfileId, setNewBookmarkProfileId] = useState('');
  const [newBookmarkName, setNewBookmarkName] = useState('');
  const [newBookmarkStartTime, setNewBookmarkStartTime] = useState('');
  const [newBookmarkEndTime, setNewBookmarkEndTime] = useState('');
  const [newBookmarkMaxFrames, setNewBookmarkMaxFrames] = useState('');

  // Reset helpers
  const resetCatalogForm = () => {
    setCatalogName('');
    setCatalogFilename('');
  };

  const resetBookmarkForm = () => {
    setBookmarkName('');
    setBookmarkStartTime('');
    setBookmarkEndTime('');
    setBookmarkMaxFrames('');
  };

  const resetNewBookmarkForm = () => {
    setNewBookmarkProfileId('');
    setNewBookmarkName('');
    setNewBookmarkStartTime('');
    setNewBookmarkEndTime('');
    setNewBookmarkMaxFrames('');
  };

  // Initialize catalog form for duplication
  const initDuplicateCatalogForm = (name: string, filename: string) => {
    setCatalogName(name + ' (Copy)');
    setCatalogFilename(filename.replace('.toml', '-copy.toml'));
  };

  // Initialize catalog form for editing
  const initEditCatalogForm = (name: string, filename: string) => {
    setCatalogName(name);
    setCatalogFilename(filename);
  };

  // Initialize bookmark form for editing
  const initEditBookmarkForm = (
    name: string,
    startTime: string,
    endTime: string,
    maxFrames?: number
  ) => {
    setBookmarkName(name);
    setBookmarkStartTime(startTime);
    setBookmarkEndTime(endTime);
    setBookmarkMaxFrames(maxFrames ? String(maxFrames) : '');
  };

  // Initialize new bookmark form with default profile
  const initNewBookmarkForm = (defaultProfileId: string) => {
    setNewBookmarkProfileId(defaultProfileId);
    setNewBookmarkName('');
    setNewBookmarkStartTime('');
    setNewBookmarkEndTime('');
    setNewBookmarkMaxFrames('');
  };

  return {
    // Catalog form
    catalogName,
    setCatalogName,
    catalogFilename,
    setCatalogFilename,
    resetCatalogForm,
    initDuplicateCatalogForm,
    initEditCatalogForm,

    // Bookmark form (editing)
    bookmarkName,
    setBookmarkName,
    bookmarkStartTime,
    setBookmarkStartTime,
    bookmarkEndTime,
    setBookmarkEndTime,
    bookmarkMaxFrames,
    setBookmarkMaxFrames,
    resetBookmarkForm,
    initEditBookmarkForm,

    // New bookmark form (creating)
    newBookmarkProfileId,
    setNewBookmarkProfileId,
    newBookmarkName,
    setNewBookmarkName,
    newBookmarkStartTime,
    setNewBookmarkStartTime,
    newBookmarkEndTime,
    setNewBookmarkEndTime,
    newBookmarkMaxFrames,
    setNewBookmarkMaxFrames,
    resetNewBookmarkForm,
    initNewBookmarkForm,
  };
}

export type SettingsFormsState = ReturnType<typeof useSettingsForms>;
