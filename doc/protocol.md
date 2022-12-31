---
label: Protocol
icon: book
---

## Basic Data model

![](static/concept4.png)

The core of an identity is a [Curve25519](https://en.wikipedia.org/wiki/Curve25519) key pair (256-bit key size). Each identity has one or more writers. A writer is usually a unique device, and each writer maintains it's own [Logical clock](https://en.wikipedia.org/wiki/Logical_clock). When publishing a message a writer increments it's local clock (essentially a sequence number), and includes the [Vector clock](https://en.wikipedia.org/wiki/Vector_clock) of all writers a writer is aware of. The message is then signed, and stored or published.

A consumer of a feed generated this way simply has to request the "HEAD" of the feed (the latest message), look at the vector clock embedded within it, and is made aware of every message that exists within a feed. This makes synchronization, and detecting misbehaving servers a very cheap operation. A client knows what ranges of messages it has, can ask what ranges a server has, and request only the messages that it does not have. If a message is missing the client can tell because of the clocks. A client can download ranges from multiple servers similar to a torrent without duplicated work. It is not possible for a server to hide the existence of messages before the latest message it chooses to present from a client. A server can present an outdated view of a feed, but the fact that the feed is outdated is easily checked by requesting only the head from another server.

Polycentric supports large files such as images, or audio. To facilitate this large files are split into small chunks, and these chunks are signed, and published individually along with a metadata message. Clients download these chunks, potentially concurrently from multiple servers, and validate each piece individually. In the case of images they are by default compressed client side before publishing to ensure a good experience for consumers.

An edge case exists where multiple writers are in a full split brain scenario (such as posting offline). In this case it would be possible for the server to present a subset of writers up to the point where the split brain happened. As soon as writers become aware of each other again they update their vector clock, and remove this possibility.

While clients cache state for offline viewing, and reduced trust in servers, the only state that must be persisted is a clients key, and counters for it's own identity. A device of limited capacity such as those found in Internet of Things may choose to persist state on multiple servers, and not cache anything locally.

The data model is fully consistent with the requirements of a peer to peer protocol. Although Polycentric clients do not currently facilitate peer to peer message delivery this will be included in the future.

## Basic Architecture

There are two basic components: clients, and servers. A client chooses to publish it's identities on multiple servers. An identity includes the necessary routing information to find it within a network. When a feed is followed the client will connect to the servers an identity is available on and start synchronizing. The set of servers a user chooses to store their own identity on can be totally disjoint from those of the people they are following. The basic feed synchronization places very limited trust in servers compared to most models. Should server operators provide unreliable service, or choose to deny service to users, the client automatically fetches feeds from other sources.

Certain features are very difficult to provide via a trustless methodology, or purely within a client. Examples of these features include recommendation engines, and search. Each Polycentric server provides search and recommendation, but has control over what data it chooses to present. A server could choose to return some results, and not others. To combine the best of both worlds Clients use multiple servers of their choosing to provide search and recommendations. Results are deduplicated and attributed to the server that provided them. This allows using high performance and state of the art solutions to these difficult problems, but limit the manipulation possible by a single actor.

The server architecture itself is intended to handle millions of users and is not limited to a single node. The core server process is intended to be horizontally scaled behind a load balancer, utilize a cluster for search, a database with replicas, object storage for large files, and a distributed caching layer. While it is possible to run small single node instances, handling large numbers of users requires following a standard modern system architecture.

