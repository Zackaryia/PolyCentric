import { Avatar, Button, Paper } from '@mui/material';
import { Link } from 'react-router-dom';
import React, { useState, useEffect, useRef, memo } from 'react';
import { useNavigate } from 'react-router-dom';
import ReplyIcon from '@mui/icons-material/Reply';
import LoopIcon from '@mui/icons-material/Loop';
import DeleteIcon from '@mui/icons-material/Delete';
import ImageViewer from 'react-simple-image-viewer';
import * as Base64 from '@borderless/base64';
import * as Lodash from 'lodash';

import * as Core from 'polycentric-core';
import * as Feed from './Feed';
import PostModal from './PostModal';
import './Post.css';
import * as ProfileUtil from './ProfileUtil';

export type DisplayablePost = {
    pointer: Core.Protocol.Pointer;
    profile: ProfileUtil.DisplayableProfile;
    message: string;
    image?: string;
    unixMilliseconds: number;
    author: boolean;
    boost: DisplayablePost | undefined;
    fromServer?: string;
};

type PostProps = {
    state: Core.DB.PolycentricState;
    post: DisplayablePost;
    showBoost: boolean;
    depth: number;
};

export type PostLoaderProps = {
    state: Core.DB.PolycentricState;
    initialPost: DisplayablePost;
    showBoost: boolean;
    depth: number;
    dependsOn: Array<Core.Protocol.Pointer>;
};

export async function tryLoadDisplayable(
    state: Core.DB.PolycentricState,
    pointer: Core.Protocol.Pointer,
    needPointers: Array<Core.Protocol.Pointer>,
) {
    const event = await Core.DB.tryLoadStorageEventByPointer(state, pointer);

    if (event === undefined || event.event === undefined) {
        return undefined;
    }

    const body = Core.Protocol.EventBody.decode(event.event.content);

    const profiles = new Map<string, ProfileUtil.DisplayableProfile>();

    const displayable = await Feed.eventToDisplayablePost(
        state,
        profiles,
        {
            event: event.event,
            mutationPointer: undefined,
        },
        needPointers,
    );

    return displayable;
}

export const PostLoaderMemo = memo(PostLoader);

export function PostLoader(props: PostLoaderProps) {
    console.log('PostLoader');
    const [displayable, setDisplayable] = useState<DisplayablePost>(
        props.initialPost,
    );

    const loadCard = async (
        dependencyListeners: [Core.Protocol.Pointer, () => void][],
    ) => {
        const needPointers = new Array<Core.Protocol.Pointer>();

        const displayable = await tryLoadDisplayable(
            props.state,
            props.initialPost.pointer,
            needPointers,
        );

        if (displayable === undefined) {
            return;
        }

        const cb = Lodash.once(() => {
            loadCard(dependencyListeners);
        });

        for (const dependency of needPointers) {
            dependencyListeners.push([dependency, cb]);

            Core.DB.waitOnEvent(props.state, dependency, cb);
        }

        displayable.fromServer = props.initialPost.fromServer;

        setDisplayable(displayable);
    };

    useEffect(() => {
        const dependencyListeners: [Core.Protocol.Pointer, () => void][] = [];

        const cb = Lodash.once(() => {
            loadCard(dependencyListeners);
        });

        for (const dependency of props.dependsOn) {
            dependencyListeners.push([dependency, cb]);

            Core.DB.waitOnEvent(props.state, dependency, cb);
        }

        if (props.dependsOn.length !== 0) {
            loadCard(dependencyListeners);
        }

        return () => {
            for (const listener of dependencyListeners) {
                Core.DB.cancelWaitOnEvent(
                    props.state,
                    listener[0],
                    listener[1],
                );
            }
        };
    }, []);

    return (
        <Post
            state={props.state}
            post={displayable}
            showBoost={props.showBoost}
            depth={props.depth}
        />
    );
}

function processText(message: string) {
    let position = 0;
    return (
        <div>
            {message.split(/(\s+)/g).map((section: string) => {
                if (section.startsWith('#')) {
                    position++;
                    return (
                        <span key={position.toString()}>
                            <Link
                                className="hashTag"
                                to={`/search/${encodeURIComponent(section)}`}
                            >
                                {section}
                            </Link>
                            &nbsp;
                        </span>
                    );
                } else if (
                    section.startsWith('https://') ||
                    section.startsWith('http://')
                ) {
                    position++;
                    return (
                        <span key={position.toString()}>
                            <a href={section} target="_blank">
                                {section}
                            </a>
                        </span>
                    );
                } else {
                    return section;
                }
            })}
        </div>
    );
}

function postToLink(pointer: Core.Protocol.Pointer): string {
    return Base64.encodeUrl(
        Core.Protocol.URLInfo.encode({
            publicKey: pointer.publicKey,
            writerId: pointer.writerId,
            sequenceNumber: pointer.sequenceNumber,
            servers: [],
        }).finish(),
    );
}

function Post(props: PostProps) {
    let navigate = useNavigate();

    const [viewerLink, setViewerLink] = useState<string | undefined>(undefined);
    const [modalIsOpen, setModalIsOpen] = useState(false);

    const handleBoost = async () => {
        const event = Core.DB.makeDefaultEventBody();
        event.message = {
            message: new Uint8Array(),
            boostPointer: props.post.pointer,
        };

        await Core.DB.levelSavePost(props.state, event);
    };

    const handleNavigate = (event: React.MouseEvent<HTMLDivElement>) => {
        navigate('/' + postToLink(props.post.pointer));
    };

    return (
        <Paper
            elevation={4}
            style={{
                marginTop: '15px',
                paddingRight: '5px',
            }}
        >
            {props.post.fromServer !== undefined && (
                <div
                    style={{
                        paddingLeft: '5px',
                        paddingTop: '5px',
                        width: '100%',
                    }}
                >
                    Recommended By: &nbsp;
                    <span
                        style={{
                            color: 'gray',
                            fontWeight: 600,
                        }}
                    >
                        {props.post.fromServer}
                    </span>
                    <div
                        style={{
                            width: '99%',
                            marginTop: '5px',
                            marginLeft: 'auto',
                            marginRight: 'auto',
                            borderBottom: '1px solid gray',
                        }}
                    />
                </div>
            )}
            <div
                style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                }}
            >
                <PostModal
                    state={props.state}
                    isOpen={modalIsOpen}
                    onClose={() => {
                        setModalIsOpen(false);
                    }}
                    boostPointer={props.post.pointer}
                />
                <div className="post__avatar">
                    <Avatar
                        src={props.post.profile.avatar}
                        onClick={() => {
                            setViewerLink(props.post.profile.avatar);
                        }}
                    />
                </div>
                <div className="post__main">
                    <div className="post__header">
                        <div
                            className="post__headerText"
                            style={{
                                whiteSpace: 'pre-wrap',
                                overflowWrap: 'anywhere',
                            }}
                        >
                            <h3
                                onClick={() => {
                                    navigate('/' + props.post.profile.link);
                                }}
                            >
                                {props.post.profile.displayName}{' '}
                                <span
                                    style={{
                                        fontWeight: '600',
                                        fontSize: '12px',
                                        color: 'gray',
                                    }}
                                >
                                    @{props.post.profile.identity}
                                </span>
                            </h3>
                        </div>
                        <div className="post__content">
                            <div
                                style={{
                                    whiteSpace: 'pre-wrap',
                                    overflowWrap: 'anywhere',
                                }}
                            >
                                {processText(props.post.message)}
                            </div>
                            <div
                                style={{
                                    display: 'flex',
                                    justifyContent: 'center',
                                }}
                            >
                                <img
                                    hidden={props.post.image === undefined}
                                    className="post__image"
                                    src={props.post.image}
                                    alt="Within Post"
                                    style={{
                                        marginTop: '10px',
                                        maxHeight: '500px',
                                    }}
                                    onClick={() => {
                                        setViewerLink(props.post.image);
                                    }}
                                />
                                {viewerLink && (
                                    <ImageViewer
                                        src={[viewerLink]}
                                        currentIndex={0}
                                        closeOnClickOutside={true}
                                        onClose={() => {
                                            setViewerLink(undefined);
                                        }}
                                        backgroundStyle={{
                                            backgroundColor: 'rgba(0,0,0,0.5)',
                                            zIndex: 1300,
                                        }}
                                    />
                                )}
                            </div>
                        </div>
                        {props.post.boost !== undefined && props.depth < 1 && (
                            <Post
                                state={props.state}
                                post={props.post.boost}
                                showBoost={false}
                                depth={props.depth + 1}
                            />
                        )}
                        {props.post.boost !== undefined && props.depth >= 1 && (
                            <Paper
                                elevation={4}
                                style={{
                                    textAlign: 'center',
                                }}
                            >
                                <h4
                                    onClick={handleNavigate}
                                    className="expandWarning"
                                >
                                    Too many nested posts. Click to expand...
                                </h4>
                            </Paper>
                        )}
                        <div
                            style={{
                                fontWeight: '600',
                                fontSize: '12px',
                                color: 'gray',
                                display: 'flex',
                                justifyContent: 'space-between',
                            }}
                        >
                            <p>
                                Posted on: &nbsp;
                                {new Date(
                                    props.post.unixMilliseconds,
                                ).toLocaleString()}
                            </p>
                            {/*
                            <p onClick={handleNavigate}>
                                {props.post.pointer.sequenceNumber}
                            </p>
                            */}
                        </div>
                        {props.showBoost === true && (
                            <div
                                style={{
                                    display: 'flex',
                                    columnGap: '5px',
                                }}
                            >
                                <Button
                                    variant="contained"
                                    onClick={handleBoost}
                                    startIcon={<LoopIcon />}
                                    size="small"
                                >
                                    Boost
                                </Button>
                                <Button
                                    variant="contained"
                                    onClick={() => {
                                        setModalIsOpen(true);
                                    }}
                                    startIcon={<ReplyIcon />}
                                    size="small"
                                >
                                    React
                                </Button>
                                <div
                                    style={{
                                        flexGrow: '1',
                                    }}
                                />
                                {props.post.author && (
                                    <Button
                                        variant="contained"
                                        size="small"
                                        color="warning"
                                        onClick={() => {
                                            Core.DB.deletePost(
                                                props.state,
                                                props.post.pointer,
                                            );
                                        }}
                                    >
                                        <DeleteIcon />
                                    </Button>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </Paper>
    );
}

export default Post;
