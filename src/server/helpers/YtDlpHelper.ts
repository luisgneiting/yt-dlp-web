import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { Stats, promises as fs } from 'fs';
import numeral from 'numeral';
import { throttle } from 'lodash';
import { CacheHelper, getCacheFilePath } from '@/server/helpers/CacheHelper';
import { FFmpegHelper } from '@/server/helpers/FFmpegHelper';
import type {
  PlaylistMetadata,
  SelectQuality,
  VideoFormat,
  VideoInfo,
  VideoMetadata
} from '@/types/video';
import { randomUUID } from 'crypto';
import { isDevelopment, qualityToYtDlpCmdOptions } from '@/lib/utils';
import { COOKIES_FILE, DOWNLOAD_PATH } from '@/server/constants';

const downloadProgressRegex =
  /^\[download\]\s+([0-9.]+%)\s+of[ ~]+([0-9.a-zA-Z/]+)\s+at\s+([0-9a-zA-Z./ ]+)\s+ETA\s+([0-9a-zA-Z./: ]+)/im;
const fileRegex = /^\[Merger\]\sMerging\sformats\sinto\s\"(.+)\"$/m;
const filePathRegex = new RegExp(`^(${DOWNLOAD_PATH}/(.+)\\.(.+))$`, 'm');
const streamFilePathRegex = new RegExp(`file:(${DOWNLOAD_PATH}/(.+)\\.(.+))'$`, 'm');
// const thumbnailRegex = new RegExp(
//   `^\\[info\\]\\sWriting\\svideo\\sthumbnail\\s.+\\s(${DOWNLOAD_PATH}/.+)$`,
//   'm'
// );
// const moveThumbnailMessageRegex = new RegExp(
//   `^\\[MoveFiles\\] Moving file .+${CACHE_PATH}/thumbnails/(.+)\\"$`,
//   'm'
// );
const downloadingItemRegex = /^\[download\]\sDownloading\sitem\s([0-9]+)\sof\s([0-9]+)$/m;
const finishedDownloadingPlaylistRegex = /^\[download\]\sFinished\sdownloading\splaylist\:(.+)$/m;
const extractingURLRegex = /^\[.+\]\sExtracting\sURL\:\s(.+)$/m;
const playlistFolderPrefixRegexString = '\\[Playlist\\]';
const downloadDestinationRegex = /^\[download\]\sDestination\:\s(.+)$/m;
const playlistFolderPrefix = '[Playlist]';
const ffmpegProgressTrackingRegex =
  /^frame=([0-9 ]+)\s+fps=([0-9. ]+)\s+q=([-0-9. ]+)\s+(L?size)=([0-9a-zA-Z. ]+)\s+time=([0-9:. -]+)\s+bitrate=([0-9a-zA-Z./ ]+)\s+speed=([0-9a-zA-Z./ ]+)$/;
const cutsTimeRegex = /^[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{2}$/;

/**
 *
 * @param timeString '02:04:03' or '02:04:03.33'
 * @returns minutes(number)
 */
const convertToMinutes = function (_timeString: string) {
  const [timeString, millisecond] = _timeString.split('.');
  if (!/[0-9]{2}:[0-9]{2}:[0-9]{2}/.test(timeString)) {
    return NaN;
  }
  return (
    timeString.split(':').reduce(function (seconds, v) {
      return +v + seconds * 60;
    }, 0) + (Number(`0.${millisecond}`) || 0)
  );
};

export class YtDlpHelper {
  public readonly url: string;
  private readonly videoInfo: VideoInfo = {
    status: 'standby',
    uuid: '',
    id: '',
    url: '',
    title: '',
    description: '',
    thumbnail: '',
    localThumbnail: null,
    isLive: false,
    videoId: '',
    audioId: '',
    format: 'bv+ba/b',
    usingCookies: false,
    embedChapters: false,
    // embedMetadata: false,
    embedSubs: false,
    subLangs: [],
    enableProxy: false,
    proxyAddress: '',
    enableLiveFromStart: false,
    cutVideo: false,
    cutStartTime: '',
    cutEndTime: '',
    outputFilename: '',
    selectQuality: '',
    enableForceKeyFramesAtCuts: false,
    file: {
      name: null,
      path: null
    },
    playlist: [],
    download: {
      pid: null,
      progress: null,
      speed: null
    },
    updatedAt: Date.now(),
    createdAt: Date.now()
  };
  private ytdlp?: ChildProcessWithoutNullStreams;
  private isDownloadStarted = false;
  private isFormatExist = false;
  private pid?: number;
  private metadata?: VideoMetadata | PlaylistMetadata;

  constructor(querys: {
    url: string;
    uuid?: string;
    videoId?: string;
    audioId?: string;
    format?: string;
    pid?: number;
    usingCookies: boolean;
    embedChapters?: boolean;
    // embedMetadata?: boolean;
    embedSubs?: boolean;
    subLangs?: Array<string>;
    enableProxy?: boolean;
    proxyAddress?: string;
    enableLiveFromStart?: boolean;
    cutVideo?: boolean;
    cutStartTime?: string;
    cutEndTime?: string;
    outputFilename?: string;
    selectQuality?: SelectQuality;
    enableForceKeyFramesAtCuts?: boolean;
  }) {
    this.url = querys.url;
    this.pid = querys.pid;
    this.metadata = undefined;
    this.videoInfo.url = querys.url;
    this.videoInfo.videoId = querys.videoId;
    this.videoInfo.audioId = querys.audioId;
    this.videoInfo.format = querys.format || 'bv+ba/b';
    this.videoInfo.usingCookies = querys.usingCookies;
    this.videoInfo.embedChapters = querys.embedChapters || false;
    this.videoInfo.embedSubs = querys.embedSubs || false;
    this.videoInfo.subLangs = querys.subLangs || [];
    this.videoInfo.enableProxy = querys.enableProxy || false;
    this.videoInfo.proxyAddress = querys.proxyAddress || '';
    this.videoInfo.enableLiveFromStart = querys.enableLiveFromStart || false;
    this.videoInfo.outputFilename = querys.outputFilename || '';
    this.videoInfo.selectQuality = querys.selectQuality || '';
    this.videoInfo.enableForceKeyFramesAtCuts = querys.enableForceKeyFramesAtCuts || false;

    if (querys.cutStartTime && cutsTimeRegex.test(querys.cutStartTime))
      this.videoInfo.cutStartTime = querys.cutStartTime;
    if (querys.cutEndTime && cutsTimeRegex.test(querys.cutEndTime))
      this.videoInfo.cutEndTime = querys.cutEndTime;

    if (this.videoInfo.cutStartTime || this.videoInfo.cutEndTime) {
      this.videoInfo.cutVideo = true;
    } else {
      this.videoInfo.cutVideo = false;
      this.videoInfo.cutStartTime = '';
      this.videoInfo.cutEndTime = '';
      this.videoInfo.enableForceKeyFramesAtCuts = false;
    }

    if (querys.uuid) this.videoInfo.uuid = querys.uuid;
  }

  public async start({
    uuid,
    isDownloadRestart,
    downloadStartCallback,
    downloadErrorCallback,
    processExitCallback
  }: {
    uuid: string;
    isDownloadRestart: boolean;
    downloadStartCallback?: () => void;
    downloadErrorCallback?: (error: string) => void;
    processExitCallback?: () => void;
  }): Promise<void> {
    const metadata = await this.getMetadata().catch((error: string) => error);

    if (typeof metadata === 'string') {
      const errorMessage = metadata || 'Not found. Please check the url again.';
      this.videoInfo.status = 'failed';
      this.videoInfo.error = errorMessage;
      await CacheHelper.set(uuid, this.videoInfo);
      downloadErrorCallback?.(errorMessage);
      return;
    }

    if (!metadata?.id) {
      const errorMessage = 'Not found. Please check the url again.';
      this.videoInfo.status = 'failed';
      this.videoInfo.error = errorMessage;
      await CacheHelper.set(uuid, this.videoInfo);
      downloadErrorCallback?.(errorMessage);
      return;
    }

    const options = [
      '--verbose',
      '--progress',
      '--no-continue',
      '--windows-filenames',
      '--recode-video mp4 --postprocessor-args "-c:v libx264 -c:a aac"',
      // '--write-thumbnail',
      // '-o',
      // `thumbnail:${CACHE_PATH}/thumbnails/${CACHE_FILE_PREFIX}${uuid}.%(ext)s`,
      // '--print',
      // 'after_move:filepath',
      '--merge-output-format',
      'mp4',
      '-P',
      DOWNLOAD_PATH
    ];

    if (!this.videoInfo.cutVideo) {
      options.push('--print', 'after_move:filepath');
    }

    if (this.videoInfo?.usingCookies) {
      options.push('--cookies', getCacheFilePath(COOKIES_FILE, 'txt'));
    }

    if (
      this.videoInfo?.enableProxy &&
      typeof this.videoInfo?.proxyAddress === 'string' &&
      this.videoInfo?.proxyAddress
    ) {
      options.push('--proxy', this.videoInfo?.proxyAddress);
    }

    switch (metadata.type) {
      case 'video': {
        const selectQuality = this.videoInfo.selectQuality;
        if (selectQuality) {
          const cmdOptions = qualityToYtDlpCmdOptions(selectQuality);
          const format = cmdOptions[cmdOptions.length - 1];
          this.videoInfo.format = format;
          options.push(...cmdOptions);
        } else {
          options.push('-f', this.videoInfo.format);
        }
        options.push('--no-playlist');

        if (this.videoInfo?.outputFilename) {
          options.push('-o', this.videoInfo.outputFilename);
        } else {
          if (metadata?.isLive) {
            options.push('-o', `%(title)s %(epoch-3600>%y-%m-%d %H_%M)s(%(id)s).%(ext)s`);
          } else {
            options.push('-o', '%(title)s (%(id)s).%(ext)s');
          }
        }

        if (metadata?.isLive) {
          options.push('--no-part');
          if (this.videoInfo?.enableLiveFromStart) {
            options.push('--live-from-start');
          }
        } else {
          if (this.videoInfo?.embedChapters) {
            options.push('--embed-chapters');
          }
          if (this.videoInfo?.embedSubs || this.videoInfo.subLangs.length > 0) {
            if (this.videoInfo.subLangs.length === 0 || this.videoInfo.subLangs.includes('all')) {
              this.videoInfo.subLangs = ['all'];
            }
            options.push('--embed-subs');
            options.push('--sub-langs', this.videoInfo.subLangs.join(','));
          }

          if (this.videoInfo?.cutVideo) {
            const ffpmegSliceTimeArgs: Array<string> = ['*'];

            // if (this.videoInfo?.cutStartTime)
            //   ffpmegSliceTimeArgs.push('-ss', this.videoInfo.cutStartTime);
            // if (this.videoInfo?.cutEndTime)
            //   ffpmegSliceTimeArgs.push('-to', this.videoInfo.cutEndTime);

            // if (ffpmegSliceTimeArgs.length) {
            //   const downloaderArgs = `ffmpeg_i:${ffpmegSliceTimeArgs.join(' ')}`;
            //   options.push('--downloader', 'ffmpeg', '--downloader-args', downloaderArgs);
            // }

            // options.push('--force-keyframes-at-cuts', '--download-sections', '*00:01:30.00-00:01:51.00');
            options.push(
              '--download-sections',
              `*${this.videoInfo.cutStartTime || '00:00:00.00'}-${
                this.videoInfo.cutEndTime || 'inf'
              }`
            );

            if (this.videoInfo.enableForceKeyFramesAtCuts) {
              options.push('--force-keyframes-at-cuts');
            }
          }
        }
        break;
      }
      case 'playlist': {
        options.push(
          '-f',
          'bv+ba/b',
          '--match-filter',
          '!is_live',
          '-o',
          `${playlistFolderPrefix} %(playlist_title)s(%(playlist_id)s)/%(title)s (%(id)s).%(ext)s`
        );
        this.videoInfo.format = 'bv+ba/b';
        break;
      }
    }

    return new Promise(async (resolve) => {
      const downloadOptions = [...options, this.url];
      const ytdlp = spawn('yt-dlp', downloadOptions, {
        killSignal: 'SIGINT',
        cwd: DOWNLOAD_PATH
      });

      console.info(
        `[${new Date().toISOString()}] [new process] [yt-dlp pid: ${ytdlp.pid}]`,
        'downloadOptions:',
        JSON.stringify(downloadOptions)
      );

      if (ytdlp.pid) {
        this.videoInfo.download.pid = ytdlp.pid;
      }
      await CacheHelper.set(uuid, this.videoInfo);

      this.ytdlp = ytdlp;

      ytdlp.stdout.setEncoding('utf-8');
      ytdlp.stderr.setEncoding('utf-8');
      if (isDevelopment) {
        ytdlp.stdout.on('data', (data) => {
          console.debug('[stdout]', data?.trim?.());
        });
        ytdlp.stderr.on('data', (data) => {
          console.debug('[stderr]', data?.trim?.());
        });
      }

      switch (metadata.type) {
        case 'video': {
          await this.downloadVideo({
            uuid,
            downloadErrorCallback,
            downloadStartCallback,
            processExitCallback
          });
          break;
        }
        case 'playlist': {
          downloadStartCallback?.();
          await this.downloadPlaylist({
            uuid
          });
          break;
        }
      }

      return resolve();
    });
  }

  public async getMetadata(): Promise<VideoMetadata | PlaylistMetadata> {
    if (this.metadata) {
      return new Promise((resolve) => {
        resolve(this.metadata!);
      });
    }
    let stdoutChunks = [] as Array<any>;
    let stderrMessage = '';

    const options = ['--dump-single-json', '--playlist-items', '0'];

    if (this.videoInfo?.usingCookies) {
      options.push('--cookies', getCacheFilePath(COOKIES_FILE, 'txt'));
    }
    if (
      this.videoInfo?.enableProxy &&
      typeof this.videoInfo?.proxyAddress === 'string' &&
      this.videoInfo?.proxyAddress
    ) {
      options.push('--proxy', this.videoInfo?.proxyAddress);
    }

    options.push(this.url);

    const ytdlp = spawn('yt-dlp', options);

    ytdlp.stdout.on('data', (data) => {
      stdoutChunks.push(data);
    });

    ytdlp.stderr.setEncoding('utf-8');
    ytdlp.stderr.on('data', (data) => {
      const text = data?.trim?.();

      if (text.startsWith('ERROR: ')) {
        stderrMessage = text?.split('\n')?.[0] || text;
      }
    });

    return new Promise((resolve, reject) => {
      ytdlp.on('exit', () => {
        try {
          const buffer = Buffer.concat(stdoutChunks);
          if (!buffer.length) {
            reject(stderrMessage || 'Not found. Please check the url again.');
            return;
          }
          const json = JSON.parse(buffer.toString());
          downloadOptionsconst type = json?._type;

          switch (type) {
            case 'playlist': {
              const metadata: PlaylistMetadata = {
                id: json.id ?? '',
                title: json.title ?? '',
                description: json.description ?? '',
                thumbnail:
                  Array.isArray(json?.thumbnails) && json.thumbnails.length > 0
                    ? json.thumbnails[json.thumbnails.length - 1]?.url ?? ''
                    : '',
                playlistCount: json.playlist_count ?? '',
                type,
                originalUrl: json.original_url ?? ''
              };
              this.metadata = metadata;
              resolve(metadata);
              break;
            }
            case 'video': {
              const metadata: VideoMetadata = {
                id: json.id || '',
                originalUrl: json.original_url || '',
                title: json.title || '',
                description: json.description || '',
                thumbnail: json.thumbnail || '',
                isLive: json.is_live || false,
                type,
                duration: json.duration || 0,
                best: {
                  formatId: json.format_id ?? '',
                  formatNote: json.format_note ?? '',
                  fps: json.fps ?? '',
                  resolution: json.resolution ?? '',
                  width: json.width ?? '',
                  height: json.height ?? '',
                  dynamicRange: json.dynamic_range ?? '',
                  vcodec: json.vcodec ?? '',
                  acodec: json.acodec ?? '',
                  filesize: json.filesize ?? ''
                },
                formats:
                  json.formats
                    ?.map((format: any) => {
                      return {
                        formatId: format.format_id ?? '',
                        formatNote: format.format_note ?? '',
                        resolution: format.resolution ?? '',
                        fps: format.fps ?? '',
                        dynamicRange: format.dynamic_range ?? '',
                        vcodec: format.vcodec ?? '',
                        acodec: format.acodec ?? '',
                        filesize: format.filesize ?? '',
                        videoExt: format?.video_ext ?? '',
                        audioExt: format?.audio_ext ?? '',
                        width: format?.width ?? '',
                        height: format?.height ?? '',
                        url: format?.url ?? ''
                      } as VideoFormat;
                    })
                    .filter((format: any) => format.format_note !== 'storyboard') || [],
                subtitles: json.subtitles ?? {}
              };
              this.metadata = metadata;
              resolve(metadata);
              break;
            }
            default: {
              const errorMessage = stderrMessage || 'Failed fetching formats';
              console.info(
                `[${new Date().toISOString()}] [failed get metadata] [yt-dlp pid: ${ytdlp.pid}]`,
                errorMessage
              );
              reject(errorMessage);
              break;
            }
          }
        } catch (err) {
          const errorMessage = err || 'Failed fetching formats, downloading best available';
          console.info(
            `[${new Date().toISOString()}] [failed get metadata] [yt-dlp pid: ${ytdlp.pid}]`,
            errorMessage
          );

          reject(errorMessage);
        }
      });
    });
  }

  getPid(): number {
    if (!this.pid) {
      throw "Process isn't started";
    }
    return this.pid;
  }

  getVideoInfo() {
    return this.videoInfo;
  }

  getIsDownloadStarted() {
    return this.isDownloadStarted;
  }

  setIsDownloadStarted(isDownloadStarted: boolean) {
    this.isDownloadStarted = isDownloadStarted;
  }

  getIsFormatExist() {
    return this.isFormatExist;
  }

  private async downloadVideo({
    uuid,
    downloadStartCallback,
    downloadErrorCallback,
    processExitCallback
  }: {
    uuid: string;
    downloadStartCallback?: () => void;
    downloadErrorCallback?: (error: string) => void;
    processExitCallback?: () => void;
  }) {
    const metadata = this.metadata as VideoMetadata;
    const ytdlp = this.ytdlp;
    if (!ytdlp || !metadata) {
      return;
    }

    const videoInfo = this.videoInfo;

    videoInfo.uuid = uuid;
    videoInfo.id = metadata?.id || '';
    videoInfo.url = this.url;
    videoInfo.title = metadata?.title || '';
    videoInfo.description = metadata?.description || '';
    videoInfo.thumbnail = metadata?.thumbnail || '';
    videoInfo.isLive = metadata?.isLive || false;
    videoInfo.updatedAt = Date.now();
    videoInfo.createdAt = Date.now();
    videoInfo.download.pid = ytdlp.pid!;
    videoInfo.type = 'video';

    const throttleCacheSet = throttle(CacheHelper.set, 500);
    let _fileDestination: string | null = null;
    let cachingInterval: NodeJS.Timeout | null = null;

    const initialListener = async (_text: string) => {
      if (this.isDownloadStarted) {
        ytdlp.stdout.off('data', initialListener);
        ytdlp.stderr.off('data', initialListener);
        return;
      }
      const text = _text?.trim?.();
      if (!text) return;

      try {
        // Search Thumbnail
        // if (!videoInfo.localThumbnail) {
        //   const findThumbnail = thumbnailRegex.exec(text)?.[1];
        //   if (findThumbnail) {
        //     videoInfo.localThumbnail = findThumbnail;
        //     return;
        //   }
        // }

        if (text.endsWith('has already been downloaded')) {
          this.isFormatExist = true;
          const error = 'Has already been downloaded';
          this.videoInfo.status = 'already';
          this.videoInfo.error = error;
          await CacheHelper.set(uuid, this.videoInfo);
          return downloadErrorCallback?.(error);
        }

        if (text.startsWith('ERROR: ')) {
          const error = text?.split('\n')?.[0] || text;
          this.videoInfo.status = 'failed';
          this.videoInfo.error = error;
          await CacheHelper.set(uuid, this.videoInfo);
          console.info(
            `[${new Date().toISOString()}] [failed download] [yt-dlp pid: ${ytdlp.pid}]`,
            error
          );
          return downloadErrorCallback?.(error);
        }

        let fileDestination = '';
        if (this.videoInfo.cutVideo) {
          fileDestination = downloadDestinationRegex.exec(text)?.[1] || '';
        } else {
          fileDestination =
            streamFilePathRegex.exec(text)?.[1] || downloadDestinationRegex.exec(text)?.[1] || '';
        }

        if (!fileDestination) {
          return;
        }

        if (metadata.isLive) {
          videoInfo.status = 'recording';
        } else {
          videoInfo.status = 'downloading';
        }
        videoInfo.file.name = fileDestination.replace(DOWNLOAD_PATH + '/', '');
        videoInfo.file.path = fileDestination;

        if (metadata.isLive && !cachingInterval) {
          cachingInterval = setInterval(async () => {
            const filePath = videoInfo?.file?.path;
            videoInfo.updatedAt = Date.now();
            videoInfo.download.pid = ytdlp?.pid || null;
            if (filePath) {
              try {
                const stat = await fs.stat(filePath);
                if (stat) {
                  videoInfo.file.size = stat.size;
                }
              } catch (e) {}
            }
            await throttleCacheSet(uuid, videoInfo);
          }, 3000);
        }

        try {
          // if (!isDownloadRestart) {
          // const uuidList = (await CacheHelper.get<string[]>(VIDEO_LIST_FILE)) || [];
          // uuidList.unshift(uuid);
          // await CacheHelper.set(VIDEO_LIST_FILE, uuidList);
          await CacheHelper.set(uuid, videoInfo);
          // }
        } catch (e) {}

        ytdlp.stdout.off('data', initialListener);
        ytdlp.stderr.off('data', initialListener);
        this.setIsDownloadStarted(true);
        ytdlp.stdout.on('data', downloadListener);
        ytdlp.stderr.on('data', downloadListener);

        downloadStartCallback?.();
      } catch (e) {}
    };

    const streamDownloadListener = async (message: string) => {
      // const movedThumbnailDestination = moveThumbnailMessageRegex.exec(message)?.[1];

      // if (movedThumbnailDestination) {
      //   videoInfo.status = 'merging';
      //   videoInfo.localThumbnail = movedThumbnailDestination.replace(
      //     new RegExp(`^${CACHE_FILE_PREFIX}`),
      //     ''
      //   );
      //   return;
      // }

      if (message.startsWith('[Fixup')) {
        videoInfo.status = 'merging';
        return;
      }

      if (message.startsWith('ERROR: ffmpeg exited')) {
        if (cachingInterval) clearInterval(cachingInterval);
        videoInfo.status = 'failed';
        videoInfo.error = message;

        if (ytdlp?.pid) {
          ytdlp?.kill(2);
          videoInfo.download.pid = null;
        }
        await CacheHelper.set(uuid, videoInfo);
        console.info(
          `[${new Date().toISOString()}] [failed download] [yt-dlp pid: ${ytdlp.pid}]`,
          message
        );
        return;
      }

      const fileDestination = filePathRegex.exec(message)?.[1];

      if (fileDestination) {
        videoInfo.download.pid = ytdlp?.pid || null;
        videoInfo.file.path = fileDestination;
        videoInfo.file.name = fileDestination.replace(DOWNLOAD_PATH + '/', '');
        _fileDestination = fileDestination;
        return;
      }
    };

    const videoDownloadListener = async (message: string) => {
      const messageType = /^\[([a-z]+)\]\s/i.exec(message)?.[1];
      if (!messageType) {
        if (message.startsWith('ERROR: ')) {
          const error = message?.split('\n')?.[0] || message;
          this.videoInfo.status = 'failed';
          this.videoInfo.error = error;
          await CacheHelper.set(uuid, this.videoInfo);
          console.info(
            `[${new Date().toISOString()}] [failed download] [yt-dlp pid: ${ytdlp.pid}]`,
            message
          );
          return;
        }

        const isFilePathMessage = filePathRegex.test(message);
        if (isFilePathMessage) {
          videoInfo.file.path = message;
          videoInfo.file.name = message.replace(DOWNLOAD_PATH + '/', '');
          videoInfo.download.pid = null;
          videoInfo.download.progress = '1';
          videoInfo.status = 'completed';
        }

        if (this.videoInfo.cutVideo) {
          const progress = ffmpegProgressTrackingRegex.exec(message);
          if (progress) {
            const [, frame, fps, q, sizeType, size, time, bitrate, speed] = progress;
            videoInfo.status = 'downloading';
            videoInfo.download.pid = ytdlp.pid!;
            videoInfo.download.ffmpeg = {
              frame: frame.trim(),
              fps: fps.trim(),
              q: q.trim(),
              sizeType: sizeType.trim(),
              size: size.trim(),
              time: time.trim(),
              bitrate: bitrate.trim(),
              speed: speed.trim()
            };
            videoInfo.updatedAt = Date.now();
            await throttleCacheSet(uuid, videoInfo);
          }
        }
        return;
      }

      try {
        switch (messageType) {
          case 'download': {
            const execResult = downloadProgressRegex.exec(message);
            if (execResult) {
              // const match = execResult[0];
              const progress = execResult[1];
              // const filesize = execResult[2];
              const speed = execResult[3];
              videoInfo.status = 'downloading';
              videoInfo.download.pid = ytdlp.pid!;
              videoInfo.download.progress = numeral(progress).format('0.00');
              videoInfo.download.speed = numeral(speed).format('0.0b') + '/s';
              videoInfo.updatedAt = Date.now();
              await throttleCacheSet(uuid, videoInfo);
            }
            break;
          }
          case 'Merger': {
            const filePath = fileRegex.exec(message)?.[1];
            if (!filePath) {
              break;
            }

            videoInfo.file.path = filePath;
            videoInfo.file.name = filePath.replace(DOWNLOAD_PATH + '/', '');
            videoInfo.download.pid = ytdlp.pid!;
            videoInfo.download.progress = '1';
            videoInfo.status = 'merging';
            videoInfo.updatedAt = Date.now();
            await CacheHelper.set(uuid, videoInfo);
            break;
          }

          // case 'MoveFiles': {
          //   const movedThumbnailDestination = moveThumbnailMessageRegex.exec(message)?.[1];
          //   if (movedThumbnailDestination) {
          //     videoInfo.localThumbnail = movedThumbnailDestination.replace(
          //       new RegExp(`^${CACHE_FILE_PREFIX}`),
          //       ''
          //     );
          //   }
          //   break;
          // }
        }
      } catch (e) {}
    };

    const streamDownloadEndListener = async () => {
      if (!this.isDownloadStarted) return;
      const fileDestination = _fileDestination;
      if (!fileDestination) {
        return;
      }
      let stat: Stats | null = null;
      _fileDestination = null;
      try {
        stat = await fs.stat(fileDestination);
      } catch (e) {}
      if (stat) {
        if (cachingInterval) clearInterval(cachingInterval);

        videoInfo.download.pid = null;
        videoInfo.download.progress = '1';
        videoInfo.status = 'completed';
        videoInfo.file.path = fileDestination;
        videoInfo.file.name = fileDestination.replace(DOWNLOAD_PATH + '/', '');
        videoInfo.file.size = stat.size;
        videoInfo.updatedAt = Date.now();
        await CacheHelper.set(uuid, videoInfo);
        console.info(
          `[${new Date().toISOString()}] [complete download] [yt-dlp pid: ${ytdlp.pid}]`
        );

        try {
          const ffmpeg = new FFmpegHelper({ filePath: videoInfo.file.path });
          await ffmpegHelper.repair();
          const streams = await ffmpeg.getVideoStreams();
          videoInfo.file = {
            ...videoInfo.file,
            ...streams
          };
        } catch (error) {}
        videoInfo.updatedAt = Date.now();
        await CacheHelper.set(uuid, videoInfo);
      }
    };

    const videoDownloadEndListener = async () => {
      if (!this.isDownloadStarted) return;
      if (videoInfo.file.path) {
        let stat: Stats | null = null;
        try {
          stat = await fs.stat(videoInfo.file.path);
          if (stat) {
            videoInfo.download.pid = null;
            videoInfo.download.progress = '1';
            videoInfo.status = 'completed';
            videoInfo.file.size = stat.size;

            const ffmpeg = new FFmpegHelper({
              filePath: videoInfo.file.path
            });
            const streams = await ffmpeg.getVideoStreams();
            videoInfo.file = {
              ...videoInfo.file,
              ...streams
            };
          }
        } catch (e) {}
      }
      videoInfo.updatedAt = Date.now();
      await CacheHelper.set(uuid, videoInfo);
      console.info(`[${new Date().toISOString()}] [complete download] [yt-dlp pid: ${ytdlp.pid}]`);
    };

    const downloadListener = async (_text: string) => {
      const message = _text?.trim?.();
      if (!message) return;

      if (metadata.isLive) {
        await streamDownloadListener(message);
      } else {
        await videoDownloadListener(message);
      }
    };

    ytdlp.stdout.on('data', initialListener);
    ytdlp.stderr.on('data', initialListener);
    ytdlp.stdout.on('end', metadata.isLive ? streamDownloadEndListener : videoDownloadEndListener);

    ytdlp?.on('exit', async () => {
      if (cachingInterval) clearInterval(cachingInterval);
      processExitCallback?.();
    });
  }

  private async downloadPlaylist({ uuid }: { uuid: string }) {
    const metadata = this.metadata as PlaylistMetadata;
    const ytdlp = this.ytdlp;
    if (!ytdlp || !metadata) {
      return;
    }

    const throttleCacheSet = throttle(CacheHelper.set, 500);
    let cachingInterval: NodeJS.Timeout | null = null;
    let currentDownloadingIndex = 0;

    const videoInfo = this.videoInfo;
    videoInfo.uuid = uuid;
    videoInfo.id = metadata?.id || '';
    videoInfo.url = this.url;
    videoInfo.title = metadata?.title || '';
    videoInfo.description = metadata?.description || '';
    videoInfo.thumbnail = metadata?.thumbnail || '';
    videoInfo.isLive = false;
    videoInfo.updatedAt = Date.now();
    videoInfo.createdAt = Date.now();
    videoInfo.download.pid = ytdlp.pid!;
    videoInfo.type = 'playlist';
    videoInfo.playlist = videoInfo.playlist || [];
    videoInfo.download.playlist = {
      current: currentDownloadingIndex + 1,
      count: metadata.playlistCount
    };

    const videoDownloadListener = async (_text: string) => {
      const message = _text?.trim?.();
      if (!message) return;

      let currentIndex = currentDownloadingIndex;

      if (message.startsWith('ERROR: ')) {
        videoInfo.playlist[currentIndex] = {
          uuid: randomUUID(),
          url: videoInfo.playlist[currentIndex]?.url
        };
        videoInfo.playlist[currentIndex].error = message?.split('\n')?.[0] || message;
        return;
      }

      const isFilePathMessage = filePathRegex.test(message);
      if (isFilePathMessage) {
        const filePath = message;
        try {
          const stat = await fs.stat(filePath);

          if (stat) {
            const size = stat.size;
            const streams = await new FFmpegHelper({ filePath }).getVideoStreams();

            videoInfo.playlist[currentIndex] = {
              ...videoInfo.playlist[currentIndex],
              ...streams,
              size,
              path: filePath,
              name: filePath.replace(
                new RegExp(`^${DOWNLOAD_PATH}/${playlistFolderPrefixRegexString}\\s.+/`, 'm'),
                ''
              )
            };
            const dirPath = new RegExp(
              `^(${DOWNLOAD_PATH}/${playlistFolderPrefixRegexString}\\s.+)/`,
              'm'
            ).exec(filePath);
            if (dirPath) {
              videoInfo.playlistDirPath = dirPath[1];
            }
            videoInfo.updatedAt = Date.now();
            await throttleCacheSet(uuid, videoInfo);
          }
        } catch (e) {}
      }

      const hasAlready = new RegExp(
        `^\\[download\\] (${DOWNLOAD_PATH}/.+) has already been downloaded$`,
        'm'
      ).exec(message);
      if (hasAlready) {
        const filePath = hasAlready[1];
        try {
          const stat = await fs.stat(filePath);

          if (stat) {
            const size = stat.size;
            const streams = await new FFmpegHelper({ filePath }).getVideoStreams();

            videoInfo.playlist[currentIndex] = {
              ...videoInfo.playlist[currentIndex],
              ...streams,
              size,
              uuid: randomUUID(),
              path: filePath,
              name: filePath.replace(
                new RegExp(`^${DOWNLOAD_PATH}/${playlistFolderPrefixRegexString}\\s.+/`, 'm'),
                ''
              )
            };
            const dirPath = new RegExp(
              `^(${DOWNLOAD_PATH}/${playlistFolderPrefixRegexString}\\s.+)/`,
              'm'
            ).exec(filePath);
            if (dirPath) {
              videoInfo.playlistDirPath = dirPath[1];
            }
            videoInfo.updatedAt = Date.now();
            await throttleCacheSet(uuid, videoInfo);
          }
        } catch (e) {}
      }

      const downloadProgress = downloadProgressRegex.exec(message);
      if (downloadProgress) {
        // const match = downloadProgress[0];
        const progress = downloadProgress[1];
        // const filesize = downloadProgress[2];
        const speed = downloadProgress[3];
        videoInfo.status = 'downloading';
        videoInfo.download.pid = ytdlp.pid!;
        videoInfo.download.progress = numeral(progress).format('0.00');
        videoInfo.download.speed = speed;
        videoInfo.updatedAt = Date.now();
        await throttleCacheSet(uuid, videoInfo);
      }

      const downloadingItem = downloadingItemRegex.exec(message);
      if (downloadingItem) {
        const current = Number(downloadingItem[1]) - 1;
        currentIndex = current;
        currentDownloadingIndex = current;
        videoInfo.playlist[current] = { uuid: randomUUID() };
        videoInfo.status = 'downloading';
        videoInfo.download.pid = ytdlp.pid!;
        videoInfo.download.playlist = {
          current: current + 1,
          count: metadata.playlistCount
        };
        videoInfo.download.progress = '0';
        videoInfo.updatedAt = Date.now();
        await throttleCacheSet(uuid, videoInfo);
      }

      const downloadDestination = downloadDestinationRegex.exec(message);
      if (downloadDestination) {
        const filePath = downloadDestination[1];
        if (videoInfo.playlist[currentIndex]) {
          videoInfo.playlist[currentIndex].path = filePath;
          videoInfo.playlist[currentIndex].name = filePath.replace(
            new RegExp(`^${DOWNLOAD_PATH}/${playlistFolderPrefixRegexString}\\s.+/`, 'm'),
            ''
          );
          const dirPath = new RegExp(
            `^(${DOWNLOAD_PATH}/${playlistFolderPrefixRegexString}\\s.+)/`,
            'm'
          ).exec(filePath);
          if (dirPath) {
            videoInfo.playlistDirPath = dirPath[1];
          }
        }
      }

      const extractingUrl = extractingURLRegex.exec(message);
      if (extractingUrl && videoInfo.playlist[currentIndex]) {
        videoInfo.playlist[currentIndex].url = extractingUrl[1];
      }

      const isLiveSkip = message.includes('!is_live');
      if (isLiveSkip && /skipping\s\.\.$/m.test(message)) {
        videoInfo.playlist[currentIndex].isLive = true;
        videoInfo.updatedAt = Date.now();
        await throttleCacheSet(uuid, videoInfo);
      }

      const isFinished = finishedDownloadingPlaylistRegex.test(message);
      if (isFinished) {
        videoInfo.download.progress = '1';
        videoInfo.status = 'completed';
        videoInfo.updatedAt = Date.now();

        await Promise.all(
          videoInfo.playlist.map(async (item, i) => {
            try {
              videoInfo.playlist[i].uuid = item.uuid || randomUUID();

              const filePath = item.path;
              if (!filePath) {
                return;
              }

              const stat = await fs.stat(filePath);
              if (stat) {
                videoInfo.playlist[i].size = stat.size;
              }
            } catch (e) {}
          })
        );

        await throttleCacheSet(uuid, videoInfo);
        console.info(
          `[${new Date().toISOString()}] [complete download] [yt-dlp pid: ${ytdlp.pid}]`
        );
      }

      const filePath = fileRegex.exec(message)?.[1];
      if (filePath) {
        if (!videoInfo.playlist[currentIndex]) {
          videoInfo.playlist[currentIndex] = { uuid: randomUUID() };
        }
        videoInfo.playlist[currentIndex].path = filePath;
        videoInfo.playlist[currentIndex].name = filePath.replace(
          new RegExp(`^${DOWNLOAD_PATH}/${playlistFolderPrefixRegexString}\\s.+/`, 'm'),
          ''
        );
        videoInfo.download.pid = ytdlp.pid!;
        videoInfo.status = 'merging';
        videoInfo.updatedAt = Date.now();
        await throttleCacheSet(uuid, videoInfo);
      }
    };

    if (!cachingInterval) {
      cachingInterval = setInterval(async () => {
        videoInfo.updatedAt = Date.now();
        videoInfo.download.pid = ytdlp?.pid || null;
        await throttleCacheSet(uuid, videoInfo);
      }, 3000);
    }

    ytdlp.stdout.on('data', videoDownloadListener);
    ytdlp.stderr.on('data', videoDownloadListener);

    ytdlp.on('exit', async () => {
      if (cachingInterval) {
        clearInterval(cachingInterval);
      }
      videoInfo.updatedAt = Date.now();
      videoInfo.download.pid = null;
      await throttleCacheSet(uuid, videoInfo);
    });
  }
}
