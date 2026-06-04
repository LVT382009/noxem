"""
LLM utils for RAG benchmarks with Qwen3-8B and Qwen2.5-VL (multimodal)
"""

import time

try:
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    HF_AVAILABLE = True
except ImportError:
    HF_AVAILABLE = False

try:
    from vllm import LLM, SamplingParams

    VLLM_AVAILABLE = True
except ImportError:
    VLLM_AVAILABLE = False


def is_qwen3_model(model_name):
    """Check if model is Qwen3"""
    return "Qwen3" in model_name or "qwen3" in model_name.lower()


def is_qwen_vl_model(model_name):
    """Check if model is Qwen2.5-VL"""
    return "Qwen2.5-VL" in model_name or "qwen2.5-vl" in model_name.lower()


def apply_qwen3_chat_template(tokenizer, prompt):
    """Apply Qwen3 chat template with thinking enabled"""
    messages = [{"role": "user", "content": prompt}]
    return tokenizer.apply_chat_template(
        messages,
        tokenize=False,
        add_generation_prompt=True,
        enable_thinking=True,
    )


def extract_thinking_answer(response):
    """Extract final answer from Qwen3 thinking model response"""
    if "<think>" in response and "</think>" in response:
        try:
            think_end = response.index("</think>") + len("</think>")
            final_answer = response[think_end:].strip()
            return final_answer
        except (ValueError, IndexError):
            pass

    return response.strip()


def load_hf_model(model_name="Qwen/Qwen3-8B", trust_remote_code=False):
    """Load HuggingFace model

    Args:
        model_name (str): Name of the model to load
        trust_remote_code (bool): Whether to allow execution of code from the model repository.
            Defaults to False for security. Only enable for trusted models.
    """
    if not HF_AVAILABLE:
        raise ImportError("transformers not available")

    if trust_remote_code:
        print(
            "⚠️  WARNING: Loading model with trust_remote_code=True. This can execute arbitrary code."
        )

    print(f"Loading HF: {model_name}")
    tokenizer = AutoTokenizer.from_pretrained(model_name, trust_remote_code=trust_remote_code)
    model = AutoModelForCausalLM.from_pretrained(
        model_name,
        torch_dtype=torch.float16 if torch.cuda.is_available() else torch.float32,
        device_map="auto",
        trust_remote_code=trust_remote_code,
    )
    return tokenizer, model


def load_vllm_model(model_name="Qwen/Qwen3-8B", trust_remote_code=False):
    """Load vLLM model

    Args:
        model_name (str): Name of the model to load
        trust_remote_code (bool): Whether to allow execution of code from the model repository.
            Defaults to False for security. Only enable for trusted models.
    """
    if not VLLM_AVAILABLE:
        raise ImportError("vllm not available")

    if trust_remote_code:
        print(
            "⚠️  WARNING: Loading model with trust_remote_code=True. This can execute arbitrary code."
        )

    print(f"Loading vLLM: {model_name}")
    llm = LLM(model=model_name, trust_remote_code=trust_remote_code)

    # Qwen3 specific config
    if is_qwen3_model(model_name):
        stop_tokens = ["<|im_end|>", "<|end_of_text|>"]
        max_tokens = 2048
    else:
        stop_tokens = None
        max_tokens = 1024

    sampling_params = SamplingParams(temperature=0.7, max_tokens=max_tokens, stop=stop_tokens)
    return llm, sampling_params


def generate_hf(tokenizer, model, prompt, max_tokens=None):
    """Generate with HF - supports Qwen3 thinking models"""
    model_name = getattr(model, "name_or_path", "unknown")
    is_qwen3 = is_qwen3_model(model_name)

    # Apply chat template for Qwen3
    if is_qwen3:
        prompt = apply_qwen3_chat_template(tokenizer, prompt)
        max_tokens = max_tokens or 2048
    else:
        max_tokens = max_tokens or 1024

    inputs = tokenizer(prompt, return_tensors="pt").to(model.device)
    with torch.no_grad():
        outputs = model.generate(
            **inputs,
            max_new_tokens=max_tokens,
            temperature=0.7,
            do_sample=True,
            pad_token_id=tokenizer.eos_token_id,
        )
    response = tokenizer.decode(outputs[0], skip_special_tokens=True)
    response = response[len(prompt) :].strip()

    # Extract final answer for thinking models
    if is_qwen3:
        return extract_thinking_answer(response)
    return response


def generate_vllm(llm, sampling_params, prompt):
    """Generate with vLLM - supports Qwen3 thinking models"""
    outputs = llm.generate([prompt], sampling_params)
    response = outputs[0].outputs[0].text.strip()

    # Extract final answer for Qwen3 thinking models
    model_name = str(llm.llm_engine.model_config.model)
    if is_qwen3_model(model_name):
        return extract_thinking_answer(response)
    return response


def create_prompt(context, query, domain="default"):
    """Create RAG prompt"""
    if domain == "emails":
        return f"Email content:\n{context}\n\nQuestion: {query}\n\nAnswer:"
    elif domain == "finance":
        return f"Financial content:\n{context}\n\nQuestion: {query}\n\nAnswer:"
    elif domain == "multimodal":
        return f"Image context:\n{context}\n\nQuestion: {query}\n\nAnswer:"
    else:
        return f"Context: {context}\n\nQuestion: {query}\n\nAnswer:"


def evaluate_rag(searcher, llm_func, queries, domain="default", top_k=3, complexity=64):
    """Simple RAG evaluation with timing"""
    search_times = []
    gen_times = []
    results = []

    for i, query in enumerate(queries):
        # Search
        start = time.time()
        docs = searcher.search(query, top_k=top_k, complexity=complexity)
        search_time = time.time() - start

        # Generate
        context = "\n\n".join([doc.text for doc in docs])
        prompt = create_prompt(context, query, domain)

        start = time.time()
        response = llm_func(prompt)
        gen_time = time.time() - start

        search_times.append(search_time)
        gen_times.append(gen_time)
        results.append(response)

        if i < 3:
            print(f"Q{i + 1}: Search={search_time:.3f}s, Gen={gen_time:.3f}s")

    return {
        "avg_search_time": sum(search_times) / len(search_times),
        "avg_generation_time": sum(gen_times) / len(gen_times),
        "results": results,
    }


def load_qwen_vl_model(model_name="Qwen/Qwen2.5-VL-7B-Instruct", trust_remote_code=False):
    """Load Qwen2.5-VL multimodal model

    Args:
        model_name (str): Name of the model to load
        trust_remote_code (bool): Whether to allow execution of code from the model repository.
            Defaults to False for security. Only enable for trusted models.
    """
    if not HF_AVAILABLE:
        raise ImportError("transformers not available")

    if trust_remote_code:
        print(
            "⚠️  WARNING: Loading model with trust_remote_code=True. This can execute arbitrary code."
        )

    print(f"Loading Qwen2.5-VL: {model_name}")

    try:
        from transformers import AutoModelForVision2Seq, AutoProcessor

        processor = AutoProcessor.from_pretrained(model_name, trust_remote_code=trust_remote_code)
        model = AutoModelForVision2Seq.from_pretrained(
            model_name,
            torch_dtype=torch.bfloat16,
            device_map="auto",
            trust_remote_code=trust_remote_code,
        )

        return processor, model

    except Exception as e:
        print(f"Failed to load with AutoModelForVision2Seq, trying specific class: {e}")

        # Fallback to specific class
        try:
            from transformers import AutoProcessor, Qwen2VLForConditionalGeneration

            processor = AutoProcessor.from_pretrained(
                model_name, trust_remote_code=trust_remote_code
            )
            model = Qwen2VLForConditionalGeneration.from_pretrained(
                model_name,
                torch_dtype=torch.bfloat16,
                device_map="auto",
                trust_remote_code=trust_remote_code,
            )

            return processor, model

        except Exception as e2:
            raise ImportError(f"Failed to load Qwen2.5-VL model: {e2}")


def generate_qwen_vl(processor, model, prompt, image_path=None, max_tokens=512):
    """Generate with Qwen2.5-VL multimodal model"""
    from PIL import Image

    # Prepare inputs
    if image_path:
        image = Image.open(image_path)
        inputs = processor(text=prompt, images=image, return_tensors="pt").to(model.device)
    else:
        inputs = processor(text=prompt, return_tensors="pt").to(model.device)

    # Generate
    with torch.no_grad():
        generated_ids = model.generate(
            **inputs, max_new_tokens=max_tokens, do_sample=False, temperature=0.1
        )

    # Decode response
    generated_ids = generated_ids[:, inputs["input_ids"].shape[1] :]
    response = processor.decode(generated_ids[0], skip_special_tokens=True)

    return response


def create_multimodal_prompt(context, query, image_descriptions, task_type="images"):
    """Create prompt for multimodal RAG"""
    if task_type == "images":
        return f"""Based on the retrieved images and their descriptions, answer the following question.

Retrieved Image Descriptions:
{context}

Question: {query}

Provide a detailed answer based on the visual content described above."""

    return f"Context: {context}\nQuestion: {query}\nAnswer:"


def evaluate_multimodal_rag(searcher, queries, processor=None, model=None, complexity=64):
    """Evaluate multimodal RAG with Qwen2.5-VL"""
    search_times = []
    gen_times = []
    results = []

    for i, query_item in enumerate(queries):
        # Handle both string and dict formats for queries
        if isinstance(query_item, dict):
            query = query_item.get("query", "")
            image_path = query_item.get("image_path")  # Optional reference image
        else:
            query = str(query_item)
            image_path = None

        # Search
        start_time = time.time()
        search_results = searcher.search(query, top_k=3, complexity=complexity)
        search_time = time.time() - start_time
        search_times.append(search_time)

        # Prepare context from search results
        context_parts = []
        for result in search_results:
            context_parts.append(f"- {result.text}")
        context = "\n".join(context_parts)

        # Generate with multimodal model
        start_time = time.time()
        if processor and model:
            prompt = create_multimodal_prompt(context, query, context_parts)
            response = generate_qwen_vl(processor, model, prompt, image_path)
        else:
            response = f"Context: {context}"
        gen_time = time.time() - start_time

        gen_times.append(gen_time)
        results.append(response)

        if i < 3:
            print(f"Q{i + 1}: Search={search_time:.3f}s, Gen={gen_time:.3f}s")

    return {
        "avg_search_time": sum(search_times) / len(search_times),
        "avg_generation_time": sum(gen_times) / len(gen_times),
        "results": results,
    }
